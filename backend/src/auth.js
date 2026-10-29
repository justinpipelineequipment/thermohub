// Microsoft 365 (Entra ID) sign-in verification and hub token checks.
import { HttpError, sha256Hex } from './util.js';

const JWKS_URL = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';
const JWKS_TTL_MS = 6 * 3600 * 1000;
let jwks = { keys: [], fetchedAt: 0 };

const b64url = s => Uint8Array.from(
  atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')),
  c => c.charCodeAt(0));
const decodeJson = s => JSON.parse(new TextDecoder().decode(b64url(s)));

async function signingKey(kid) {
  const stale = Date.now() - jwks.fetchedAt > JWKS_TTL_MS;
  if (stale || !jwks.keys.some(k => k.kid === kid)) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new HttpError(503, 'Could not reach Microsoft sign-in keys.');
    jwks = { keys: (await res.json()).keys, fetchedAt: Date.now() };
  }
  const jwk = jwks.keys.find(k => k.kid === kid);
  if (!jwk) throw new HttpError(401, 'Unknown sign-in key.');
  return crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

// Verifies a Microsoft identity platform v2.0 ID token issued to our app by any tenant.
async function verifyEntraToken(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Malformed sign-in token.');
  let header, claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch (e) {
    throw new HttpError(401, 'Malformed sign-in token.');
  }
  if (header.alg !== 'RS256') throw new HttpError(401, 'Unsupported token algorithm.');

  const key = await signingKey(header.kid);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!valid) throw new HttpError(401, 'Invalid sign-in token.');

  const now = Date.now() / 1000;
  if (claims.exp < now - 60 || (claims.nbf && claims.nbf > now + 60)) throw new HttpError(401, 'Sign-in expired. Please sign in again.');
  if (claims.aud !== env.ENTRA_CLIENT_ID) throw new HttpError(401, 'Token was not issued for this app.');
  if (!claims.tid || claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0`) throw new HttpError(401, 'Unexpected token issuer.');
  return claims;
}

function bearer(req) {
  const h = req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new HttpError(401, 'Sign-in required.');
  return m[1];
}

export function rowToUser(r) {
  return { id: r.id, businessId: r.business_id, email: r.email, name: r.name, role: r.role,
    buildingIds: JSON.parse(r.building_ids || '[]') };
}

// Resolves the signed-in person to a ThermoHub user (or throws 401/403).
export async function authenticateUser(req, env) {
  const c = await verifyEntraToken(bearer(req), env);
  const email = String(c.preferred_username || c.email || '').toLowerCase();
  const name = c.name || email;

  const admins = String(env.PLATFORM_ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (admins.includes(email) && c.tid === env.PLATFORM_TENANT_ID) {
    return { id: 'platform:' + c.oid, businessId: null, email, name, role: 'platform_admin', buildingIds: [] };
  }

  const biz = await env.DB.prepare('SELECT id FROM businesses WHERE tenant_id = ?').bind(c.tid).first();
  if (!biz) throw new HttpError(403, 'Your organization has not been set up in ThermoHub yet.');
  const row = await env.DB.prepare('SELECT * FROM users WHERE business_id = ? AND email = ?').bind(biz.id, email).first();
  if (!row) throw new HttpError(403, `${email} has not been given access. Ask your Business Admin to add you.`);
  if (row.oid && row.oid !== c.oid) throw new HttpError(403, 'This account does not match the invited user.');
  if (!row.oid) await env.DB.prepare('UPDATE users SET oid = ? WHERE id = ?').bind(c.oid, row.id).run();
  return rowToUser(row);
}

// Hubs authenticate with a per-business secret token (only its hash is stored).
export async function authenticateHub(req, env) {
  const hash = await sha256Hex(bearer(req));
  const biz = await env.DB.prepare('SELECT id, config_version FROM businesses WHERE hub_token_hash = ?').bind(hash).first();
  if (!biz) throw new HttpError(401, 'Unknown hub token.');
  return { businessId: biz.id, configVersion: biz.config_version };
}
