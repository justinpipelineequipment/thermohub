// Dashboard API: everything a signed-in user can read or change.
import { HttpError, newId, randomToken, sha256Hex, parse } from './util.js';
import * as P from './perm.js';

const HUB_ONLINE_MS = 2 * 60 * 1000;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MODES = ['heat', 'cool', 'auto', 'off'];

// ---------- row mapping ----------
const businessOut = r => ({
  id: r.id, name: r.name, tenantDomain: r.tenant_domain, tenantId: r.tenant_id,
  hub: { online: !!r.hub_last_seen && Date.now() - r.hub_last_seen < HUB_ONLINE_MS,
    lastSeen: r.hub_last_seen, version: r.hub_version || 'not connected', paired: !!r.hub_token_hash },
});
const buildingOut = r => ({ id: r.id, businessId: r.business_id, name: r.name });
const scheduleOut = r => ({ id: r.id, businessId: r.business_id, name: r.name, ...JSON.parse(r.data) });
const userOut = r => ({ id: r.id, businessId: r.business_id, name: r.name, email: r.email, role: r.role,
  buildingIds: JSON.parse(r.building_ids || '[]') });
function thermostatOut(r) {
  const s = parse(r.state) || {};
  return {
    id: r.id, businessId: r.business_id, buildingId: r.building_id, scheduleId: r.schedule_id,
    name: r.name, entity: r.entity, model: r.model || 'ecobee', mode: r.mode,
    temp: s.temp ?? null, humidity: s.humidity ?? null, occupied: !!s.occupied, lastMotion: s.lastMotion ?? null,
    equipment: s.equipment || 'idle', rates: s.rates || { cool: 4, heat: 5 }, recovering: s.recovering ?? null,
    alert: s.alert || null, alertSince: s.alertSince ?? null, offlineSince: s.offlineSince ?? null,
    // Once the hub has applied the latest hold request it reports the hold it is actually running
    // (including motion holds); until then show what was requested.
    hold: s.holdSeq === r.hold_seq ? (s.hold || null) : parse(r.hold),
    reportedAt: r.reported_at,
  };
}

// ---------- helpers ----------
const placeholders = n => Array(n).fill('?').join(',');

async function all(env, sql, ...args) {
  return (await env.DB.prepare(sql).bind(...args).all()).results;
}

const auditStmt = (env, bizId, who, text, tId = null) =>
  env.DB.prepare('INSERT INTO audit (ts, business_id, user_name, text, thermostat_id) VALUES (?, ?, ?, ?, ?)')
    .bind(Date.now(), bizId, who, text, tId);
const bumpStmt = (env, bizId) =>
  env.DB.prepare('UPDATE businesses SET config_version = config_version + 1 WHERE id = ?').bind(bizId);

async function getBusiness(env, id) {
  const r = await env.DB.prepare('SELECT * FROM businesses WHERE id = ?').bind(id).first();
  if (!r) throw new HttpError(404, 'Business not found.');
  return r;
}
async function getBuilding(env, id) {
  const r = await env.DB.prepare('SELECT * FROM buildings WHERE id = ?').bind(id).first();
  if (!r) throw new HttpError(404, 'Building not found.');
  return buildingOut(r);
}
async function getSchedule(env, id) {
  const r = await env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first();
  if (!r) throw new HttpError(404, 'Schedule not found.');
  return scheduleOut(r);
}
async function getThermostat(env, id) {
  const r = await env.DB.prepare('SELECT * FROM thermostats WHERE id = ?').bind(id).first();
  if (!r) throw new HttpError(404, 'Thermostat not found.');
  const b = r.building_id ? await getBuilding(env, r.building_id) : null;
  return { row: r, building: b, label: (b ? b.name + ' / ' : '') + r.name };
}

// Unplaced thermostats (no building yet) can only be controlled by admins.
function requireControl(u, t) {
  const ok = t.building ? P.canControl(u, t.building) : P.isBusinessAdmin(u, t.row.business_id);
  if (!ok) throw new HttpError(403, 'You do not have permission to control this thermostat.');
}
function requireAdmin(u, bizId) {
  if (!P.isBusinessAdmin(u, bizId)) throw new HttpError(403, 'Only Business Admins can do that.');
}

async function buildingsUsing(env, scheduleId) {
  return (await all(env, `SELECT DISTINCT b.* FROM buildings b JOIN thermostats t ON t.building_id = b.id WHERE t.schedule_id = ?`, scheduleId))
    .map(buildingOut);
}

const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function cleanSchedule(d) {
  if (!d || typeof d !== 'object') throw new HttpError(400, 'Schedule data missing.');
  const num = v => { const n = Number(v); if (!Number.isFinite(n)) throw new HttpError(400, 'Invalid number in schedule.'); return n; };
  const name = String(d.name || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Give the schedule a name.');
  const sp = p => ({ heat: num(p && p.heat), cool: num(p && p.cool) });
  const out = {
    name,
    occupied: sp(d.occupied),
    unoccupied: sp(d.unoccupied),
    days: {},
    motionRule: { enabled: !!(d.motionRule && d.motionRule.enabled), holdMinutes: num(d.motionRule && d.motionRule.holdMinutes),
      extendOnMotion: !!(d.motionRule && d.motionRule.extendOnMotion) },
    recovery: { enabled: !!(d.recovery && d.recovery.enabled), maxMinutes: num(d.recovery && d.recovery.maxMinutes),
      staggerMinutes: num(d.recovery && d.recovery.staggerMinutes) },
    // Profiles saved before this setting existed allow 60-minute, ±3° changes at the thermostat.
    localAdjust: d.localAdjust
      ? { enabled: !!d.localAdjust.enabled, minutes: num(d.localAdjust.minutes), maxDegrees: num(d.localAdjust.maxDegrees) }
      : { enabled: true, minutes: 60, maxDegrees: 3 },
  };
  for (const k of ['occupied', 'unoccupied']) {
    const p = out[k];
    if (!(p.heat >= 45 && p.heat <= 90 && p.cool >= 50 && p.cool <= 95)) throw new HttpError(400, 'Setpoints must be between 45° and 95°.');
    if (p.cool - p.heat < 2) throw new HttpError(400, 'Cool setpoint must be at least 2° above heat setpoint.');
  }
  for (const day of DAYS) {
    const list = Array.isArray(d.days && d.days[day]) ? d.days[day] : [];
    out.days[day] = list.slice(0, 6).map(p => {
      const start = String(p.start), end = String(p.end);
      if (!/^\d\d:\d\d$/.test(start) || !/^\d\d:\d\d$/.test(end) || toMin(end) <= toMin(start)) {
        throw new HttpError(400, 'Each occupied period must end after it starts.');
      }
      return { start, end };
    });
  }
  if (!(out.motionRule.holdMinutes >= 15 && out.motionRule.holdMinutes <= 720)) throw new HttpError(400, 'Motion hold time must be 15–720 minutes.');
  if (!(out.recovery.maxMinutes >= 15 && out.recovery.maxMinutes <= 240)) throw new HttpError(400, 'Recovery can start 15–240 minutes early.');
  if (!(out.recovery.staggerMinutes >= 0 && out.recovery.staggerMinutes <= 60)) throw new HttpError(400, 'Stagger must be 0–60 minutes.');
  if (!(out.localAdjust.minutes >= 15 && out.localAdjust.minutes <= 480)) throw new HttpError(400, 'Changes at the thermostat can last 15–480 minutes.');
  if (!(out.localAdjust.maxDegrees >= 1 && out.localAdjust.maxDegrees <= 10)) throw new HttpError(400, 'Changes at the thermostat can be limited to 1°–10°.');
  return out;
}

// ---------- reads ----------
export async function me({ user }) {
  return { user, roles: P.ROLES };
}

export async function state({ env, user, url }) {
  const sel = url.searchParams.get('business');
  let bizRows = P.isPlatform(user)
    ? await all(env, 'SELECT * FROM businesses ORDER BY name')
    : await all(env, 'SELECT * FROM businesses WHERE id = ?', user.businessId);
  if (sel && sel !== 'all') bizRows = bizRows.filter(b => b.id === sel);
  const ids = bizRows.map(b => b.id);
  if (!ids.length) return { user, businesses: [], buildings: [], schedules: [], thermostats: [], users: [], audit: [], serverTime: Date.now() };

  const inList = `IN (${placeholders(ids.length)})`;
  const [bRows, sRows, tRows, uRows, aRows] = await Promise.all([
    all(env, `SELECT * FROM buildings WHERE business_id ${inList} ORDER BY name`, ...ids),
    all(env, `SELECT * FROM schedules WHERE business_id ${inList} ORDER BY name`, ...ids),
    all(env, `SELECT * FROM thermostats WHERE business_id ${inList} ORDER BY name`, ...ids),
    all(env, `SELECT * FROM users WHERE business_id ${inList} ORDER BY name`, ...ids),
    all(env, `SELECT * FROM audit WHERE business_id ${inList} ORDER BY ts DESC LIMIT 200`, ...ids),
  ]);

  const buildings = bRows.map(buildingOut).filter(b => P.canViewBuilding(user, b));
  const visible = new Set(buildings.map(b => b.id));
  const thermostats = tRows.map(thermostatOut).filter(t =>
    t.buildingId ? visible.has(t.buildingId) : P.isBusinessAdmin(user, t.businessId));

  return {
    user,
    businesses: bizRows.map(businessOut),
    buildings,
    schedules: sRows.map(scheduleOut),
    thermostats,
    users: uRows.filter(r => P.canManageUsers(user, r.business_id)).map(userOut),
    audit: aRows.map(r => ({ ts: r.ts, businessId: r.business_id, userName: r.user_name, text: r.text, thermostatId: r.thermostat_id })),
    serverTime: Date.now(),
  };
}

// ---------- thermostat control ----------
export async function setMode({ env, user, params: [id], body }) {
  const t = await getThermostat(env, id);
  requireControl(user, t);
  if (!MODES.includes(body.mode)) throw new HttpError(400, 'Unknown mode.');
  await env.DB.batch([
    env.DB.prepare('UPDATE thermostats SET mode = ? WHERE id = ?').bind(body.mode, id),
    bumpStmt(env, t.row.business_id),
    auditStmt(env, t.row.business_id, user.name, `Set ${t.label} mode to ${body.mode}`, id),
  ]);
}

export async function setHold({ env, user, params: [id], body }) {
  const t = await getThermostat(env, id);
  requireControl(user, t);
  const heat = Number(body.heat), cool = Number(body.cool);
  const until = body.until == null ? null : Number(body.until);
  if (!(heat >= 45 && heat <= 90 && cool >= 50 && cool <= 95)) throw new HttpError(400, 'Setpoints must be between 45° and 95°.');
  if (cool - heat < 2) throw new HttpError(400, 'Cool setpoint must be at least 2° above heat setpoint.');
  if (until !== null && !(until > Date.now())) throw new HttpError(400, 'Hold must end in the future.');
  const hold = { type: 'manual', heat, cool, until, by: user.name };
  await env.DB.batch([
    env.DB.prepare('UPDATE thermostats SET hold = ?, hold_seq = hold_seq + 1 WHERE id = ?').bind(JSON.stringify(hold), id),
    bumpStmt(env, t.row.business_id),
    auditStmt(env, t.row.business_id, user.name,
      `Hold ${t.label} at ${heat}°–${cool}°` + (until ? ` until ${new Date(until).toISOString()}` : ' indefinitely'), id),
  ]);
}

export async function resume({ env, user, params: [id] }) {
  const t = await getThermostat(env, id);
  requireControl(user, t);
  await env.DB.batch([
    env.DB.prepare('UPDATE thermostats SET hold = NULL, hold_seq = hold_seq + 1 WHERE id = ?').bind(id),
    bumpStmt(env, t.row.business_id),
    auditStmt(env, t.row.business_id, user.name, `Resumed schedule on ${t.label}`, id),
  ]);
}

export async function resumeBuilding({ env, user, params: [id] }) {
  const b = await getBuilding(env, id);
  if (!P.canControl(user, b)) throw new HttpError(403, 'You do not have permission to control this building.');
  await env.DB.batch([
    env.DB.prepare('UPDATE thermostats SET hold = NULL, hold_seq = hold_seq + 1 WHERE building_id = ?').bind(id),
    bumpStmt(env, b.businessId),
    auditStmt(env, b.businessId, user.name, `Resumed schedule on all thermostats in ${b.name}`),
  ]);
}

// ---------- schedules ----------
export async function assignSchedule({ env, user, body }) {
  const s = await getSchedule(env, body.scheduleId);
  const ids = Array.isArray(body.thermostatIds) ? body.thermostatIds.slice(0, 500) : [];
  const stmts = [];
  for (const id of ids) {
    const t = await getThermostat(env, id);
    if (t.row.business_id !== s.businessId || t.row.schedule_id === s.id) continue;
    const ok = t.building ? P.canAssignSchedule(user, t.building) : P.isBusinessAdmin(user, s.businessId);
    if (!ok) continue;
    stmts.push(env.DB.prepare('UPDATE thermostats SET schedule_id = ? WHERE id = ?').bind(s.id, id));
  }
  const n = stmts.length;
  if (n) {
    stmts.push(bumpStmt(env, s.businessId),
      auditStmt(env, s.businessId, user.name, `Assigned ${n} thermostat${n === 1 ? '' : 's'} to "${s.name}"`));
    await env.DB.batch(stmts);
  }
  return { assigned: n };
}

export async function createSchedule({ env, user, body }) {
  await getBusiness(env, body.businessId);
  if (!P.canCreateSchedule(user, body.businessId)) throw new HttpError(403, 'Only Business Admins can create schedules.');
  const { name, ...data } = cleanSchedule(body.data);
  const id = newId('sch');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO schedules (id, business_id, name, data, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, body.businessId, name, JSON.stringify(data), Date.now()),
    auditStmt(env, body.businessId, user.name, `Created schedule "${name}"`),
  ]);
  return { id };
}

export async function saveSchedule({ env, user, params: [id], body }) {
  const s = await getSchedule(env, id);
  if (!P.canEditSchedule(user, s, await buildingsUsing(env, id))) throw new HttpError(403, 'No permission to edit this schedule.');
  const { name, ...data } = cleanSchedule(body.data);
  await env.DB.batch([
    env.DB.prepare('UPDATE schedules SET name = ?, data = ?, updated_at = ? WHERE id = ?').bind(name, JSON.stringify(data), Date.now(), id),
    bumpStmt(env, s.businessId),
    auditStmt(env, s.businessId, user.name, `Updated schedule "${name}"`),
  ]);
}

export async function deleteSchedule({ env, user, params: [id] }) {
  const s = await getSchedule(env, id);
  if (!P.canCreateSchedule(user, s.businessId)) throw new HttpError(403, 'Only Business Admins can delete schedules.');
  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM thermostats WHERE schedule_id = ?').bind(id).first();
  if (used.n) throw new HttpError(409, `${used.n} thermostat(s) still use this schedule. Assign them another one first.`);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM schedules WHERE id = ?').bind(id),
    auditStmt(env, s.businessId, user.name, `Deleted schedule "${s.name}"`),
  ]);
}

// ---------- users ----------
function cleanUser(body) {
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'Enter a name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (!P.ASSIGNABLE_ROLES.includes(body.role)) throw new HttpError(400, 'Unknown role.');
  const buildingIds = body.role === 'business_admin' ? [] : (Array.isArray(body.buildingIds) ? body.buildingIds.map(String) : []);
  return { email, name, role: body.role, buildingIds };
}

async function checkBuildingsBelong(env, bizId, ids) {
  if (!ids.length) return;
  const rows = await all(env, `SELECT id FROM buildings WHERE business_id = ? AND id IN (${placeholders(ids.length)})`, bizId, ...ids);
  if (rows.length !== ids.length) throw new HttpError(400, 'Unknown building in list.');
}

export async function createUser({ env, user, body }) {
  await getBusiness(env, body.businessId);
  if (!P.canManageUsers(user, body.businessId)) throw new HttpError(403, 'No permission to manage users.');
  const u = cleanUser(body);
  await checkBuildingsBelong(env, body.businessId, u.buildingIds);
  const exists = await env.DB.prepare('SELECT id FROM users WHERE business_id = ? AND email = ?').bind(body.businessId, u.email).first();
  if (exists) throw new HttpError(409, 'A user with that email already exists.');
  const id = newId('u');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, business_id, email, name, role, building_ids) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, body.businessId, u.email, u.name, u.role, JSON.stringify(u.buildingIds)),
    auditStmt(env, body.businessId, user.name, `Added user ${u.email} (${P.ROLES[u.role]})`),
  ]);
  return { id };
}

export async function updateUser({ env, user, params: [id], body }) {
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'User not found.');
  if (!P.canManageUsers(user, row.business_id)) throw new HttpError(403, 'No permission to manage users.');
  const u = cleanUser(body);
  await checkBuildingsBelong(env, row.business_id, u.buildingIds);
  if (u.email !== row.email) {
    const exists = await env.DB.prepare('SELECT id FROM users WHERE business_id = ? AND email = ?').bind(row.business_id, u.email).first();
    if (exists) throw new HttpError(409, 'A user with that email already exists.');
  }
  // Changing the email unlinks the old Microsoft account.
  const oid = u.email === row.email ? row.oid : null;
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET email = ?, name = ?, role = ?, building_ids = ?, oid = ? WHERE id = ?')
      .bind(u.email, u.name, u.role, JSON.stringify(u.buildingIds), oid, id),
    auditStmt(env, row.business_id, user.name, `Updated user ${u.email} (${P.ROLES[u.role]})`),
  ]);
}

export async function deleteUser({ env, user, params: [id] }) {
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'User not found.');
  if (!P.canManageUsers(user, row.business_id)) throw new HttpError(403, 'No permission to manage users.');
  if (row.id === user.id) throw new HttpError(400, 'You cannot remove yourself.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
    auditStmt(env, row.business_id, user.name, `Removed user ${row.email}`),
  ]);
}

// ---------- businesses, buildings, hub pairing ----------
export async function createBusiness({ env, user, body }) {
  if (!P.isPlatform(user)) throw new HttpError(403, 'Only platform admins can add businesses.');
  const name = String(body.name || '').trim();
  const tenantId = String(body.tenantId || '').trim().toLowerCase();
  if (!name) throw new HttpError(400, 'Enter a business name.');
  if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new HttpError(400, 'Enter the Microsoft 365 tenant ID (a GUID).');
  const id = newId('biz');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO businesses (id, name, tenant_id, tenant_domain, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, name, tenantId, String(body.tenantDomain || '').trim().toLowerCase(), Date.now()),
    auditStmt(env, id, user.name, `Created business "${name}"`),
  ]);
  return { id };
}

// Issues a new hub token (shown once). Replaces any existing token.
export async function pairHub({ env, user, params: [bizId] }) {
  await getBusiness(env, bizId);
  requireAdmin(user, bizId);
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare('UPDATE businesses SET hub_token_hash = ? WHERE id = ?').bind(await sha256Hex(token), bizId),
    auditStmt(env, bizId, user.name, 'Issued a new hub token'),
  ]);
  return { token };
}

export async function createBuilding({ env, user, body }) {
  await getBusiness(env, body.businessId);
  requireAdmin(user, body.businessId);
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Enter a building name.');
  const id = newId('bld');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO buildings (id, business_id, name) VALUES (?, ?, ?)').bind(id, body.businessId, name),
    auditStmt(env, body.businessId, user.name, `Added building "${name}"`),
  ]);
  return { id };
}

export async function updateBuilding({ env, user, params: [id], body }) {
  const b = await getBuilding(env, id);
  requireAdmin(user, b.businessId);
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Enter a building name.');
  await env.DB.batch([
    env.DB.prepare('UPDATE buildings SET name = ? WHERE id = ?').bind(name, id),
    auditStmt(env, b.businessId, user.name, `Renamed building "${b.name}" to "${name}"`),
  ]);
}

export async function deleteBuilding({ env, user, params: [id] }) {
  const b = await getBuilding(env, id);
  requireAdmin(user, b.businessId);
  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM thermostats WHERE building_id = ?').bind(id).first();
  if (used.n) throw new HttpError(409, 'Move or remove this building’s thermostats first.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM buildings WHERE id = ?').bind(id),
    auditStmt(env, b.businessId, user.name, `Deleted building "${b.name}"`),
  ]);
}

// Admins name newly discovered thermostats and place them in a building.
export async function updateThermostat({ env, user, params: [id], body }) {
  const t = await getThermostat(env, id);
  requireAdmin(user, t.row.business_id);
  const name = String(body.name || t.row.name).trim().slice(0, 80);
  let buildingId = body.buildingId === undefined ? t.row.building_id : body.buildingId;
  if (buildingId) {
    const b = await getBuilding(env, buildingId);
    if (b.businessId !== t.row.business_id) throw new HttpError(400, 'Building belongs to another business.');
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE thermostats SET name = ?, building_id = ? WHERE id = ?').bind(name, buildingId || null, id),
    bumpStmt(env, t.row.business_id),
    auditStmt(env, t.row.business_id, user.name, `Updated thermostat "${name}"`, id),
  ]);
}
