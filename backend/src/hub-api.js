// Hub API: each business's onsite hub polls these (outbound HTTPS only, no tunnel needed).
//   GET  /hub/config  -> schedules + desired thermostat settings (fetch when configVersion changes)
//   POST /hub/report  -> current thermostat readings and hub-side events (motion overrides, recovery)
import { HttpError, newId } from './util.js';

const EQUIPMENT = ['idle', 'heating', 'cooling'];
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
  const existing = new Map((await env.DB.prepare('SELECT id, entity FROM thermostats WHERE business_id = ?')
    .bind(hub.businessId).all()).results.map(r => [r.entity, r.id]));

  const stmts = [];
  for (const t of list) {
    const entity = str(t.entity, 200);
    if (!/^climate\.[a-z0-9_]+$/.test(entity)) continue;
    const state = JSON.stringify(cleanState(t.state));
    const model = str(t.model || 'ecobee', 100);
    const id = existing.get(entity);
    if (id) {
      stmts.push(env.DB.prepare('UPDATE thermostats SET state = ?, reported_at = ?, model = ? WHERE id = ?')
        .bind(state, now, model, id));
    } else {
      const newIdValue = newId('t');
      const name = str(t.name || entity, 80);
      existing.set(entity, newIdValue);
      stmts.push(
        env.DB.prepare('INSERT INTO thermostats (id, business_id, name, entity, model, state, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(newIdValue, hub.businessId, name, entity, model, state, now),
        env.DB.prepare('INSERT INTO audit (ts, business_id, user_name, text, thermostat_id) VALUES (?, ?, ?, ?, ?)')
          .bind(now, hub.businessId, 'Hub', `New thermostat found: ${name}. Assign it to a building.`, newIdValue));
    }
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
