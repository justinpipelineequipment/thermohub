// Hub API: each business's onsite hub polls these (outbound HTTPS only, no tunnel needed).
//   GET  /hub/config  -> schedules + desired thermostat settings (fetch when configVersion changes)
//   POST /hub/report  -> current thermostat readings and hub-side events (motion overrides, recovery)
import { HttpError, newId, parse } from './util.js';

const EQUIPMENT = ['idle', 'heating', 'cooling'];
const MOTION_KEEP_MS = 366 * 86400000;
const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max) => String(v == null ? '' : v).slice(0, max);

function cleanHold(h) {
  if (!h || typeof h !== 'object' || !['manual', 'motion', 'local'].includes(h.type)) return null;
  return { type: h.type, heat: finite(h.heat), cool: finite(h.cool), until: finite(h.until), by: str(h.by, 100) };
}

function cleanState(s) {
  s = s && typeof s === 'object' ? s : {};
  return {
    temp: finite(s.temp),
    humidity: finite(s.humidity),
    occupied: !!s.occupied,
    lastMotion: finite(s.lastMotion),
    equipment: EQUIPMENT.includes(s.equipment) ? s.equipment : 'idle',
    hold: cleanHold(s.hold),
    holdSeq: finite(s.holdSeq),
    recovering: finite(s.recovering),
    alert: s.alert ? str(s.alert, 500) : null,
    alertSince: finite(s.alertSince),
    offlineSince: finite(s.offlineSince),
    rates: s.rates && typeof s.rates === 'object'
      ? { cool: finite(s.rates.cool) || 4, heat: finite(s.rates.heat) || 5 } : { cool: 4, heat: 5 },
  };
}

export async function config({ env, hub }) {
  const [sRows, tRows] = await Promise.all([
    env.DB.prepare('SELECT * FROM schedules WHERE business_id = ?').bind(hub.businessId).all(),
    env.DB.prepare('SELECT * FROM thermostats WHERE business_id = ?').bind(hub.businessId).all(),
  ]);
  await env.DB.prepare('UPDATE businesses SET hub_last_seen = ? WHERE id = ?').bind(Date.now(), hub.businessId).run();
  return {
    configVersion: hub.configVersion,
    schedules: sRows.results.map(r => ({ id: r.id, name: r.name, ...JSON.parse(r.data) })),
    thermostats: tRows.results.map(r => ({
      id: r.id, entity: r.entity, name: r.name, buildingId: r.building_id, scheduleId: r.schedule_id,
      mode: r.mode, hold: r.hold ? JSON.parse(r.hold) : null, holdSeq: r.hold_seq,
    })),
  };
}

export async function report({ env, hub, body }) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Report body missing.');
  const now = Date.now();
  const list = Array.isArray(body.thermostats) ? body.thermostats.slice(0, 500) : [];
  const rows = (await env.DB.prepare('SELECT id, entity, state FROM thermostats WHERE business_id = ?')
    .bind(hub.businessId).all()).results;
  const existing = new Map(rows.map(r => [r.entity, r.id]));
  const wasOccupied = new Map(rows.map(r => [r.id, !!(parse(r.state) || {}).occupied]));

  const stmts = [];
  const motionStart = id => env.DB.prepare('INSERT INTO motion (business_id, thermostat_id, start_ts) VALUES (?, ?, ?)')
    .bind(hub.businessId, id, now);
  for (const t of list) {
    const entity = str(t.entity, 200);
    if (!/^climate\.[a-z0-9_]+$/.test(entity)) continue;
    const clean = cleanState(t.state);
    const state = JSON.stringify(clean);
    const model = str(t.model || 'ecobee', 100);
    const id = existing.get(entity);
    if (id) {
      stmts.push(env.DB.prepare('UPDATE thermostats SET state = ?, reported_at = ?, model = ? WHERE id = ?')
        .bind(state, now, model, id));
      if (clean.occupied && !wasOccupied.get(id)) stmts.push(motionStart(id));
      if (!clean.occupied && wasOccupied.get(id)) {
        stmts.push(env.DB.prepare('UPDATE motion SET end_ts = ? WHERE thermostat_id = ? AND end_ts IS NULL').bind(now, id));
      }
    } else {
      const newIdValue = newId('t');
      const name = str(t.name || entity, 80);
      existing.set(entity, newIdValue);
      stmts.push(
        env.DB.prepare('INSERT INTO thermostats (id, business_id, name, entity, model, state, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(newIdValue, hub.businessId, name, entity, model, state, now),
        env.DB.prepare('INSERT INTO audit (ts, business_id, user_name, text, thermostat_id) VALUES (?, ?, ?, ?, ?)')
          .bind(now, hub.businessId, 'Hub', `New thermostat found: ${name}. Assign it to a building.`, newIdValue));
      if (clean.occupied) stmts.push(motionStart(newIdValue));
    }
  }
  if (Math.random() < 0.01) {  // ~every 25 min per hub is plenty for a one-year limit
    stmts.push(env.DB.prepare('DELETE FROM motion WHERE business_id = ? AND start_ts < ? AND end_ts IS NOT NULL')
      .bind(hub.businessId, now - MOTION_KEEP_MS));
  }

  const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
  for (const e of events) {
    stmts.push(env.DB.prepare('INSERT INTO audit (ts, business_id, user_name, text, thermostat_id) VALUES (?, ?, ?, ?, ?)')
      .bind(finite(e.ts) || now, hub.businessId, str(e.who || 'Hub', 60), str(e.text, 500), existing.get(str(e.entity, 200)) || null));
  }

  stmts.push(env.DB.prepare('UPDATE businesses SET hub_last_seen = ?, hub_version = ? WHERE id = ?')
    .bind(now, str(body.version || 'unknown', 60), hub.businessId));
  await env.DB.batch(stmts);
  return { configVersion: hub.configVersion };
}
