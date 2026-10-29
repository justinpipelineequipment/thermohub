// Microsoft 365 sign-in (Entra ID, authorization code + PKCE, work accounts from any tenant).
window.Auth = (function () {
  const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
  const SCOPE = 'openid profile email offline_access';
  const KEY = 'thermohub-auth';
  const PKCE_KEY = 'thermohub-pkce';

  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* storage unavailable */ } },
  };

  const redirectUri = () => location.origin + location.pathname;
  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

  function claims(idToken) {
    const part = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(part), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async function signIn() {
    const verifier = randomString();
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const state = randomString();
    store.set(PKCE_KEY, { verifier, state, hash: location.hash });
    const q = new URLSearchParams({
      client_id: CONFIG.ENTRA_CLIENT_ID, response_type: 'code', response_mode: 'query',
      redirect_uri: redirectUri(), scope: SCOPE, state,
      code_challenge: challenge, code_challenge_method: 'S256',
    });
    location.assign(`${AUTHORITY}/authorize?${q}`);
    return new Promise(() => {}); // the page navigates away
  }

  async function tokenRequest(params) {
    const res = await fetch(`${AUTHORITY}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CONFIG.ENTRA_CLIENT_ID, scope: SCOPE, ...params }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || 'Sign-in failed.');
    const session = {
      idToken: data.id_token,
      refreshToken: data.refresh_token || params.refresh_token,
      exp: claims(data.id_token).exp * 1000,
    };
    store.set(KEY, session);
    return session;
  }

  // Completes sign-in when Microsoft redirects back with ?code=...
  async function handleRedirect() {
    const p = new URLSearchParams(location.search);
    if (!p.has('code') && !p.has('error')) return;
    const pkce = store.get(PKCE_KEY);
    store.del(PKCE_KEY);
    history.replaceState(null, '', redirectUri() + ((pkce && pkce.hash) || ''));
    if (p.has('error')) throw new Error(p.get('error_description') || p.get('error'));
    if (!pkce || pkce.state !== p.get('state')) throw new Error('Sign-in did not complete. Please try again.');
    await tokenRequest({ grant_type: 'authorization_code', code: p.get('code'),
      redirect_uri: redirectUri(), code_verifier: pkce.verifier });
  }

  // Returns a valid ID token, refreshing or redirecting to sign-in as needed.
  async function getToken(forceRefresh) {
    let s = store.get(KEY);
    if (s && !forceRefresh && s.exp - Date.now() > 5 * 60 * 1000) return s.idToken;
    if (s && s.refreshToken) {
      try { return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refreshToken })).idToken; }
      catch (e) { store.del(KEY); }
    }
    return signIn();
  }

  function signOut() {
    store.del(KEY);
    location.assign(`${AUTHORITY}/logout?post_logout_redirect_uri=${encodeURIComponent(redirectUri())}`);
  }

  return { handleRedirect, getToken, signOut };
})();
