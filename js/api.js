// Calls the ThermoHub API with the signed-in user's token.
window.Api = (function () {
  async function call(method, path, body, retried) {
    const token = await Auth.getToken(retried);
    const res = await fetch(CONFIG.API_URL + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) return call(method, path, body, true);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status}).`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  return { call };
})();
