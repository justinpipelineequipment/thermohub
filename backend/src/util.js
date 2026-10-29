export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// Empty bodies (e.g. POST /resume) read as {}.
export async function readJson(req) {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const body = JSON.parse(text);
    if (body && typeof body === 'object') return body;
  } catch (e) { /* fall through */ }
  throw new HttpError(400, 'Request body must be a JSON object.');
}

export const newId = prefix => `${prefix}-${crypto.randomUUID()}`;

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const parse = s => (s ? JSON.parse(s) : null);
