// ThermoHub API (Cloudflare Worker).
import { HttpError, json, readJson } from './util.js';
import { authenticateUser, authenticateHub } from './auth.js';
import * as U from './user-api.js';
import * as H from './hub-api.js';

const ID = '([\\w-]+)';
const r = (method, path, handler, auth = 'user') => [method, new RegExp(`^${path}$`), handler, auth];

const ROUTES = [
  r('GET', '/api/me', U.me),
  r('GET', '/api/state', U.state),
  r('GET', '/api/motion', U.motion),

  r('POST', `/api/thermostats/${ID}/mode`, U.setMode),
  r('POST', `/api/thermostats/${ID}/hold`, U.setHold),
  r('POST', `/api/thermostats/${ID}/resume`, U.resume),
  r('PUT', `/api/thermostats/${ID}`, U.updateThermostat),
  r('POST', `/api/buildings/${ID}/resume`, U.resumeBuilding),

  r('POST', '/api/schedules/assign', U.assignSchedule),
  r('POST', '/api/schedules', U.createSchedule),
  r('PUT', `/api/schedules/${ID}`, U.saveSchedule),
  r('DELETE', `/api/schedules/${ID}`, U.deleteSchedule),

  r('POST', '/api/users', U.createUser),
  r('PUT', `/api/users/${ID}`, U.updateUser),
  r('DELETE', `/api/users/${ID}`, U.deleteUser),

  r('POST', '/api/businesses', U.createBusiness),
  r('POST', `/api/businesses/${ID}/hub-token`, U.pairHub),
  r('POST', '/api/buildings', U.createBuilding),
  r('PUT', `/api/buildings/${ID}`, U.updateBuilding),
  r('DELETE', `/api/buildings/${ID}`, U.deleteBuilding),

  r('GET', '/hub/config', H.config, 'hub'),
  r('POST', '/hub/report', H.report, 'hub'),
];

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    try {
      for (const [method, re, handler, auth] of ROUTES) {
        const match = url.pathname.match(re);
        if (!match || method !== req.method) continue;
        const ctx = { env, req, url, params: match.slice(1) };
        if (auth === 'hub') ctx.hub = await authenticateHub(req, env);
        else ctx.user = await authenticateUser(req, env);
        if (method === 'POST' || method === 'PUT') ctx.body = await readJson(req);
        const result = await handler(ctx);
        return json(result || { ok: true }, 200, cors);
      }
      throw new HttpError(404, 'Not found.');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? 'Server error.' : e.message }, status, cors);
    }
  },
};
