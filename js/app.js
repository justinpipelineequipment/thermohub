// Router, page chrome, and event wiring.
(function () {
  const S = Store, esc = UI.esc;
  const main = document.getElementById('main');
  let live = false;   // current page wants periodic re-renders
  let dirty = false;  // user has unsaved input on the page
  let busy = false;   // an action is in flight

  function route() {
    const [page, id, sub] = location.hash.replace(/^#\/?/, '').split('/');
    switch (page || '') {
      case '': return Views.overview();
      case 'list': return Views.overview(id);
      case 'building': return Views.buildingPage(id, sub);
      case 'thermostat': return Views.thermostatPage(id);
      case 'schedules': return id ? Views.scheduleEditPage(id, sub) : Views.schedulesPage();
      case 'users': return Views.usersPage();
      case 'setup': case 'hubs': return Views.setupPage();
      case 'activity': return Views.activityPage();
      default: return { title: 'Not found', html: '<div class="empty">Page not found.</div>' };
    }
  }

  function render() {
    const v = route();
    main.innerHTML = v.html;
    live = !!v.live;
    document.title = `${v.title} · ${CONFIG.APP_NAME}`;
    renderNav();
  }

  function renderChrome() {
    document.getElementById('app-name').textContent = CONFIG.APP_NAME;
    document.getElementById('demo-banner').hidden = !CONFIG.DEMO_MODE;
    const u = S.currentUser();
    const st = S.state;
    const bizSelect = Perm.isPlatform(u) ? `
      <label class="top-field"><span>Business</span>
        <select class="input" id="biz-select">
          <option value="all"${st.selectedBusinessId === 'all' ? ' selected' : ''}>All businesses</option>
          ${st.businesses.map(b => `<option value="${b.id}"${st.selectedBusinessId === b.id ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}
        </select></label>` : `<span class="top-biz">${esc((S.business(u.businessId) || {}).name || '')}</span>`;
    const userBox = CONFIG.DEMO_MODE ? `
      <label class="top-field"><span>Demo: signed in as</span>
        <select class="input" id="user-select">${st.users.map(x =>
          `<option value="${x.id}"${x.id === u.id ? ' selected' : ''}>${esc(x.name)} — ${esc(Perm.ROLES[x.role])}</option>`).join('')}
        </select></label>`
      : `<span class="top-user">${esc(u.name)} <span class="muted">· ${esc(Perm.ROLES[u.role])}</span></span>
         <button class="btn small ghost" id="sign-out">Sign out</button>`;
    document.getElementById('top-controls').innerHTML = bizSelect + userBox;
  }

  function renderNav() {
    const u = S.currentUser();
    const canAdmin = Perm.isPlatform(u) || S.state.businesses.some(b => Perm.canManageUsers(u, b.id));
    const page = location.hash.replace(/^#\/?/, '').split('/')[0];
    const items = [['', 'Overview'], ['schedules', 'Schedules'], ['activity', 'Activity']];
    if (canAdmin) items.push(['users', 'Users'], ['setup', 'Setup']);
    const active = ['building', 'thermostat', 'list'].includes(page) ? '' : page === 'hubs' ? 'setup' : page;
    document.getElementById('nav').innerHTML = items.map(([k, label]) =>
      `<a href="#/${k}" class="${active === k ? 'active' : ''}">${label}</a>`).join('') +
      (CONFIG.DEMO_MODE ? `<button class="btn small ghost nav-reset" data-action="reset-demo">Reset demo data</button>` : '');
  }

  function isEditing() {
    const a = document.activeElement;
    return a && main.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
  }

  function after(r) {
    if (r === 'rerender') render();
    else if (r === 'dirty') dirty = true;
  }

  // Runs a handler that may return a value or a promise; shows any error as a toast.
  function run(fn) {
    let r;
    try { r = fn(); } catch (e) { UI.toast(e.message, true); return; }
    if (!r || typeof r.then !== 'function') return after(r);
    busy = true;
    document.body.classList.add('busy');
    r.then(after, e => UI.toast(e.message, true)).finally(() => {
      busy = false;
      document.body.classList.remove('busy');
    });
  }

  function showFatal(msg) {
    document.getElementById('nav').innerHTML = '';
    main.innerHTML = `<div class="empty"><h2>Can't open ${esc(CONFIG.APP_NAME)}</h2><p>${esc(msg)}</p>
      <button class="btn" onclick="location.reload()">Try again</button></div>`;
  }

  S.subscribe(kind => {
    if (kind === 'tick') {
      if (live && !dirty && !busy && !isEditing()) render();
      return;
    }
    dirty = false;
    renderChrome();
    render();
  });

  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-action]');
    if (el) {
      ev.preventDefault();
      if (busy) return;
      if (el.dataset.action === 'reset-demo') {
        if (el.dataset.confirm !== 'yes') { el.dataset.confirm = 'yes'; el.textContent = 'Click again to reset'; return; }
        Views.resetDrafts();
        S.actions.resetDemo();
        location.hash = '#/';
        UI.toast('Demo data reset');
        return;
      }
      const h = Views.handlers[el.dataset.action];
      if (h) run(() => h(el, ev));
      return;
    }
    const row = ev.target.closest('tr[data-href]');
    if (row && !ev.target.closest('a, select, input')) location.hash = row.dataset.href;
  });

  main.addEventListener('input', ev => {
    dirty = true;
    run(() => Views.onInput(ev.target));
  });

  document.getElementById('top-controls').addEventListener('change', ev => {
    if (ev.target.id === 'biz-select') S.actions.selectBusiness(ev.target.value);
    if (ev.target.id === 'user-select') {
      Views.resetDrafts();
      S.actions.switchUser(ev.target.value);
      location.hash = '#/';
    }
  });
  document.getElementById('top-controls').addEventListener('click', ev => {
    if (ev.target.id === 'sign-out') Auth.signOut();
  });

  window.addEventListener('hashchange', () => {
    dirty = false;
    Views.resetDrafts();
    render();
    window.scrollTo(0, 0);
  });

  main.innerHTML = '<div class="empty">Loading…</div>';
  S.start().then(() => {
    renderChrome();
    render();
  }, e => showFatal(e.message));
})();
