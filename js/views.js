// Page renderers. Each returns { title, html, live } — live pages re-render on simulation ticks.
window.Views = (function () {
  const S = Store, esc = UI.esc, badge = UI.badge;
  const DAY_LABELS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const OPEN_BADGE = { open: ['Open', 'ok'], closed: ['After hours', 'muted'], partial: ['Partly open', 'ok'] };
  const clone = o => JSON.parse(JSON.stringify(o));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Per-page editing drafts (kept outside the DOM so re-renders don't lose input).
  let schedDraft = null;   // { id, businessId, data, addIds }
  let userDraft = null;    // { id, businessId, name, email, role, buildingIds }

  function notFound() {
    return { title: 'Not found', html: `<div class="empty">That page doesn't exist, or you don't have access to it.</div>` };
  }

  // items: [label, value, kind, filterKey]; a filterKey makes the tile a link to that thermostat list.
  function kpis(items, active) {
    return `<div class="kpis">${items.map(([label, val, kind, key]) => {
      const body = `<div class="kpi-val">${val}</div><div class="kpi-label">${esc(label)}</div>`;
      return key
        ? `<a class="kpi link ${kind || ''}${key === active ? ' active' : ''}" href="#/${key === active ? '' : 'list/' + key}">${body}</a>`
        : `<div class="kpi ${kind || ''}">${body}</div>`;
    }).join('')}</div>`;
  }

  // Thermostat alert or not answering the hub (only meaningful while the hub itself is online).
  const hasProblem = t => !!t.alert || (!!t.offlineSince && S.hubOnline(t));
  const holdIs = type => t => { const h = S.effective(t).hold; return !!h && h.type === type; };

  // Overview tile filters: [heading, test].
  const FILTERS = {
    all: ['All thermostats', () => true],
    online: ['Online', t => S.hubOnline(t)],
    alerts: ['Alerts', hasProblem],
    motion: ['Motion now', t => S.hubOnline(t) && t.occupied],
    'motion-override': ['Motion overrides', holdIs('motion')],
    manual: ['Manual holds', holdIs('manual')],
    recovery: ['Smart recovery', t => S.effective(t).source === 'recovery'],
    running: ['Heating / cooling', t => t.equipment === 'heating' || t.equipment === 'cooling'],
  };

  function statusCell(t, e) {
    return `${t.offlineSince ? badge('Not responding', 'danger') + ' ' : ''}${t.alert ? badge('Alert', 'danger') + ' ' : ''}${UI.holdBadge(e)}`;
  }

  function thermostatList(key, ts) {
    const [heading, test] = FILTERS[key];
    const list = ts.filter(test);
    return `<section class="section">
      <div class="row-between section-head"><h2 class="section-title">${esc(heading)} (${list.length})</h2>
        <a class="btn small ghost" href="#/">Show buildings</a></div>
      ${list.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Thermostat</th><th>Building</th><th>Temp</th><th>Target</th><th>Equipment</th><th>Motion</th><th>Status</th></tr></thead>
        <tbody>${list.map(t => {
          const e = S.effective(t), b = S.building(t.buildingId);
          return `<tr class="row-link" data-href="#/thermostat/${t.id}">
            <td><a href="#/thermostat/${t.id}">${esc(t.name)}</a>${t.alert ? `<div class="small c-danger">${esc(t.alert)}</div>` : ''}</td>
            <td class="nowrap">${b ? esc(b.name) : '—'}</td>
            <td class="num strong">${UI.temp(t.temp)}</td>
            <td class="num nowrap">${UI.temp(e.heat)}–${UI.temp(e.cool)}</td>
            <td>${UI.equipBadge(t)}</td>
            <td class="nowrap">${UI.motionDot(t)}</td>
            <td>${statusCell(t, e)}</td></tr>`;
        }).join('')}</tbody></table></div>` : `<div class="empty">None right now.</div>`}
    </section>`;
  }

  function holdCounts(ts) {
    const effs = ts.map(S.effective);
    return {
      motion: effs.filter(e => e.hold && e.hold.type === 'motion').length,
      manual: effs.filter(e => e.hold && e.hold.type === 'manual').length,
      local: effs.filter(e => e.hold && e.hold.type === 'local').length,
      recovery: effs.filter(e => e.source === 'recovery').length,
    };
  }

  function scheduleSelect(t, attrs) {
    return `<select class="input" ${attrs}>${t.scheduleId ? '' : '<option value="" selected>Choose a profile…</option>'}${S.schedulesFor(t.businessId).map(s =>
      `<option value="${s.id}"${s.id === t.scheduleId ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
  }

  // ---------- overview ----------
  function overview(filter) {
    if (filter && !FILTERS[filter]) filter = null;
    const u = S.currentUser();
    const blds = S.visibleBuildings();
    const ts = blds.flatMap(b => S.thermostatsIn(b.id));
    const online = ts.filter(S.hubOnline);
    const holds = holdCounts(ts);
    const offline = ts.length - online.length;

    const groups = {};
    blds.forEach(b => { (groups[b.businessId] = groups[b.businessId] || []).push(b); });
    const multi = Object.keys(groups).length > 1;

    const sections = Object.entries(groups).map(([bizId, list]) => `<section class="section">
        ${multi ? `<h2 class="section-title">${esc(S.business(bizId).name)}</h2>` : ''}
        <div class="grid">${list.map(buildingCard).join('')}</div>
      </section>`).join('');

    return {
      title: 'Overview', live: true,
      html: `
        <div class="page-head"><h1>Overview</h1>
          <p class="sub">${esc(Perm.ROLES[u.role])} · ${plural(blds.length, 'building')}</p></div>
        ${kpis([
          ['Thermostats', ts.length, '', 'all'],
          ['Online', online.length, offline ? 'warn' : 'ok', 'online'],
          ['Alerts', ts.filter(hasProblem).length, ts.some(hasProblem) ? 'warn' : 'ok', 'alerts'],
          ['Motion now', online.filter(t => t.occupied).length, 'motion', 'motion'],
          ['Motion overrides', holds.motion, 'motion', 'motion-override'],
          ['Manual holds', holds.manual, 'hold', 'manual'],
          ['Smart recovery', holds.recovery, 'recovery', 'recovery'],
          ['Heating / cooling', `${ts.filter(t => t.equipment === 'heating').length} / ${ts.filter(t => t.equipment === 'cooling').length}`, '', 'running'],
        ], filter)}
        ${!blds.length ? `<div class="empty">No buildings assigned to you yet.</div>` : filter ? thermostatList(filter, ts) : sections}`,
    };
  }

  function buildingCard(b) {
    const ts = S.thermostatsIn(b.id);
    const online = S.businessOf(b).hub.online;
    const temps = ts.map(t => t.temp).filter(v => v != null);
    const avg = temps.length ? temps.reduce((a, v) => a + v, 0) / temps.length : null;
    const [openText, openKind] = OPEN_BADGE[S.buildingOpenState(b.id)];
    const holds = holdCounts(ts);
    const motion = ts.filter(t => t.occupied).length;
    const alerts = ts.filter(hasProblem).length;
    return `<a class="card bcard${online ? '' : ' offline'}" href="#/building/${b.id}">
      <div class="bcard-head"><h3>${esc(b.name)}</h3>
        ${online ? badge(openText, openKind) : badge('Hub offline', 'danger')}</div>
      <div class="bcard-temp">${UI.temp(avg)}<span>avg</span></div>
      <div class="bcard-stats">
        ${alerts ? `<span class="c-danger">${plural(alerts, 'alert')}</span>` : ''}
        <span>${plural(ts.length, 'thermostat')}</span>
        <span>${motion} with motion</span>
        ${holds.motion ? `<span class="c-motion">${holds.motion} motion override</span>` : ''}
        ${holds.manual ? `<span class="c-hold">${holds.manual} manual hold</span>` : ''}
        ${holds.local ? `<span class="c-hold">${holds.local} changed at thermostat</span>` : ''}
        ${holds.recovery ? `<span class="c-recovery">${holds.recovery} recovering</span>` : ''}
      </div>
      <div class="tiles">${ts.map(t =>
        `<span class="tile ${t.equipment}${t.occupied ? ' occ' : ''}" title="${esc(t.name)}: ${UI.temp(t.temp)}, ${t.equipment}${t.occupied ? ', motion' : ''}">${UI.temp(t.temp)}</span>`).join('')}</div>
    </a>`;
  }

  // ---------- building ----------
  function buildingPage(id, tab) {
    const b = S.building(id), u = S.currentUser();
    if (!b || !Perm.canViewBuilding(u, b)) return notFound();
    const biz = S.businessOf(b);
    const [openText] = OPEN_BADGE[S.buildingOpenState(b.id)];
    const tabs = [['', 'Thermostats'], ['schedule', 'Schedules']];
    const head = `
      <a class="back" href="#/">← Overview</a>
      <div class="page-head"><h1>${esc(b.name)}</h1><p class="sub">${esc(biz.name)} · ${openText}</p></div>
      ${biz.hub.online ? '' : `<div class="alert danger">This business's hub is offline. Showing last known values; controls are disabled.</div>`}
      <nav class="tabs">${tabs.map(([k, label]) =>
        `<a href="#/building/${b.id}${k ? '/' + k : ''}" class="${(tab || '') === k ? 'active' : ''}">${label}</a>`).join('')}</nav>`;

    const ts = S.thermostatsIn(b.id);
    if (tab === 'schedule') return { title: b.name + ' schedules', live: true, html: head + buildingSchedules(b, ts) };

    const canCtl = Perm.canControl(u, b) && biz.hub.online;
    const anyHold = ts.some(t => S.activeHold(t));
    return {
      title: b.name, live: true,
      html: head + `
        <div class="toolbar">${canCtl && anyHold ? `<button class="btn" data-action="resume-building" data-id="${b.id}">Resume schedule on all</button>` : ''}</div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Thermostat</th><th>Temp</th><th>Humidity</th><th>Target</th><th>Schedule</th><th>Equipment</th><th>Motion</th><th>Status</th></tr></thead>
          <tbody>${ts.map(t => {
            const e = S.effective(t);
            return `<tr class="row-link" data-href="#/thermostat/${t.id}">
              <td><a href="#/thermostat/${t.id}">${esc(t.name)}</a></td>
              <td class="num strong">${UI.temp(t.temp)}</td>
              <td class="num">${t.humidity == null ? '—' : t.humidity + '%'}</td>
              <td class="num nowrap">${UI.temp(e.heat)}–${UI.temp(e.cool)}</td>
              <td class="nowrap">${esc(S.scheduleOf(t).name)}</td>
              <td>${UI.equipBadge(t)}</td>
              <td class="nowrap">${UI.motionDot(t)}</td>
              <td>${statusCell(t, e)}</td></tr>`;
          }).join('')}</tbody></table></div>`,
    };
  }

  function buildingSchedules(b, ts) {
    const u = S.currentUser();
    const canAssign = Perm.canAssignSchedule(u, b);
    const now = new Date();
    return `
      <p class="hint">Each thermostat follows a schedule profile. Profiles are shared — editing one updates every thermostat using it.
        <a href="#/schedules">Manage profiles</a></p>
      ${canAssign ? `<div class="card pad bulk">
        <span>Set all thermostats in ${esc(b.name)} to</span>
        <select class="input" id="bulk-sched">${S.schedulesFor(b.businessId).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
        <button class="btn" data-action="assign-all" data-id="${b.id}">Apply</button>
      </div>` : ''}
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Thermostat</th><th>Schedule profile</th><th>Hours</th><th>Right now</th></tr></thead>
        <tbody>${ts.map(t => {
          const s = S.scheduleOf(t);
          return `<tr>
            <td><a href="#/thermostat/${t.id}">${esc(t.name)}</a></td>
            <td>${canAssign ? scheduleSelect(t, `data-assign="${t.id}"`) : s.id ? `<a href="#/schedules/${s.id}">${esc(s.name)}</a>` : esc(s.name)}</td>
            <td class="muted">${esc(UI.hoursSummary(s.days))}</td>
            <td>${S.isScheduledOccupied(s, now) ? badge('Occupied', 'ok') : badge('After hours', 'muted')}</td></tr>`;
        }).join('')}</tbody></table></div>`;
  }

  // ---------- schedule profiles ----------
  function schedulesPage() {
    const u = S.currentUser();
    const bizList = S.visibleBusinesses();
    const now = new Date();
    const sections = bizList.map(biz => {
      const list = S.schedulesFor(biz.id);
      const canCreate = Perm.canCreateSchedule(u, biz.id);
      return `<section class="section">
        <div class="row-between section-head">
          <h2 class="section-title">${bizList.length > 1 ? esc(biz.name) : 'Schedule profiles'}</h2>
          ${canCreate ? `<a class="btn small" href="#/schedules/new/${biz.id}">+ New profile</a>` : ''}</div>
        <div class="grid">${list.map(s => {
          const ts = S.thermostatsUsing(s.id);
          const blds = S.buildingsUsing(s.id);
          return `<a class="card pad scard" href="#/schedules/${s.id}">
            <div class="row-between"><h3>${esc(s.name)}</h3>
              ${S.isScheduledOccupied(s, now) ? badge('Occupied now', 'ok') : badge('After hours now', 'muted')}</div>
            <p class="muted small">${esc(UI.hoursSummary(s.days))}</p>
            <div class="scard-temps">
              <span><span class="label">Occupied</span>${UI.temp(s.occupied.heat)} – ${UI.temp(s.occupied.cool)}</span>
              <span><span class="label">After hours</span>${UI.temp(s.unoccupied.heat)} – ${UI.temp(s.unoccupied.cool)}</span>
            </div>
            <div class="bcard-stats">
              <span>${plural(ts.length, 'thermostat')} in ${plural(blds.length, 'building')}</span>
              <span class="${s.motionRule.enabled ? 'c-motion' : ''}">Motion override ${s.motionRule.enabled ? 'on' : 'off'}</span>
              <span class="${s.recovery.enabled ? 'c-recovery' : ''}">Smart recovery ${s.recovery.enabled ? 'on' : 'off'}</span>
            </div></a>`;
        }).join('') || `<div class="empty">No schedule profiles yet.</div>`}</div>
      </section>`;
    }).join('');
    return {
      title: 'Schedules',
      html: `<div class="page-head"><h1>Schedules</h1>
        <p class="sub">Build a profile once (like "Office Hours") and assign it to any thermostats in any building.</p></div>${sections}`,
    };
  }

  function blankSchedule() {
    const days = {};
    DemoData.DAYS.forEach(d => { days[d] = ['sat', 'sun'].includes(d) ? [] : [{ start: '08:00', end: '17:00' }]; });
    return { name: '', occupied: { heat: 70, cool: 74 }, unoccupied: { heat: 62, cool: 82 }, days,
      motionRule: { enabled: true, holdMinutes: 120, extendOnMotion: true },
      recovery: { enabled: true, maxMinutes: 120, staggerMinutes: 20 },
      localAdjust: { enabled: true, minutes: 60, maxDegrees: 3 } };
  }

  function scheduleEditPage(id, newBizId) {
    const u = S.currentUser();
    const isNew = id === 'new';
    const existing = isNew ? null : S.schedule(id);
    const bizId = isNew ? newBizId : existing && existing.businessId;
    if (!bizId || !S.business(bizId) || !Perm.canViewBusiness(u, bizId)) return notFound();
    if (isNew && !Perm.canCreateSchedule(u, bizId)) return notFound();

    if (!schedDraft || schedDraft.id !== id) {
      const data = isNew ? blankSchedule() : clone({ name: existing.name, occupied: existing.occupied,
        unoccupied: existing.unoccupied, days: existing.days, motionRule: existing.motionRule, recovery: existing.recovery,
        localAdjust: S.localAdjustOf(existing) });
      schedDraft = { id, businessId: bizId, data, addIds: [] };
    }
    const d = schedDraft.data;
    const canEdit = isNew || S.canEditSchedule(existing);
    const dis = canEdit ? '' : ' disabled';
    const num = (path, val) => `<input type="number" class="input num-input" min="45" max="95" data-sched="${path}" value="${val}"${dis}>`;
    const holdOpts = [15, 30, 60, 90, 120, 180, 240, 360, 480];

    // Thermostats the user can see, grouped by building, for assignment.
    const blds = S.state.buildings.filter(b => b.businessId === bizId && Perm.canViewBuilding(u, b));
    let assignable = 0;
    const assignHtml = blds.map(b => {
      const canAssign = Perm.canAssignSchedule(u, b);
      return `<div class="assign-bld"><div class="assign-name">${esc(b.name)}</div><div class="checks">${S.thermostatsIn(b.id).map(t => {
        const onThis = !isNew && t.scheduleId === id;
        const checked = onThis || schedDraft.addIds.includes(t.id);
        if (canAssign && !onThis) assignable++;
        return `<label class="check${canAssign && !onThis ? '' : ' locked'}">
          <input type="checkbox" data-add-t="${t.id}"${checked ? ' checked' : ''}${canAssign && !onThis ? '' : ' disabled'}>
          ${esc(t.name)}${onThis ? '' : ` <span class="muted small">(${esc(S.scheduleOf(t).name)})</span>`}</label>`;
      }).join('')}</div></div>`;
    }).join('');
    const usedCount = isNew ? 0 : S.thermostatsUsing(id).length;

    return {
      title: isNew ? 'New schedule' : existing.name,
      html: `
        <a class="back" href="#/schedules">← Schedules</a>
        <div class="page-head">
          ${canEdit ? `<input class="input title-input" id="sd-name" placeholder="Profile name, e.g. Office Hours" value="${esc(d.name)}">`
            : `<h1>${esc(d.name)}</h1>`}
          <p class="sub">${esc(S.business(bizId).name)}${isNew ? '' : ' · used by ' + plural(usedCount, 'thermostat')}</p></div>
        ${canEdit ? '' : `<div class="alert info">${assignable
          ? 'This profile is used outside your buildings, so only a Business Admin can change it. You can still assign it to your thermostats below.'
          : 'You have view-only access to this profile.'}</div>`}

        <div class="card pad">
          <h3>Comfort settings</h3>
          <div class="comfort">
            <div><div class="label">Occupied hours</div>
              <label>Heat to ${num('occupied.heat', d.occupied.heat)}</label>
              <label>Cool to ${num('occupied.cool', d.occupied.cool)}</label></div>
            <div><div class="label">After hours</div>
              <label>Heat to ${num('unoccupied.heat', d.unoccupied.heat)}</label>
              <label>Cool to ${num('unoccupied.cool', d.unoccupied.cool)}</label></div>
          </div>
        </div>

        <div class="card pad">
          <div class="row-between"><h3>Occupied hours</h3>
            ${canEdit ? `<button class="btn small" data-action="sched-copy-weekdays">Copy Monday to Tue–Fri</button>` : ''}</div>
          <p class="hint">Outside these hours thermostats use the after-hours settings, unless motion triggers an override.</p>
          <div class="days">${DemoData.DAYS.map(day => `
            <div class="day">
              <div class="day-name">${DAY_LABELS[day]}</div>
              <div class="periods">
                ${d.days[day].length ? d.days[day].map((p, i) => `
                  <span class="period">
                    <input type="time" class="input" data-day="${day}" data-idx="${i}" data-key="start" value="${p.start}"${dis}>
                    <span>to</span>
                    <input type="time" class="input" data-day="${day}" data-idx="${i}" data-key="end" value="${p.end}"${dis}>
                    ${canEdit ? `<button class="icon-btn" title="Remove" data-action="sched-remove" data-day="${day}" data-idx="${i}">×</button>` : ''}
                  </span>`).join('') : `<span class="muted">Closed all day</span>`}
                ${canEdit ? `<button class="btn small ghost" data-action="sched-add" data-day="${day}">+ Add hours</button>` : ''}
              </div>
            </div>`).join('')}</div>
        </div>

        <div class="card pad">
          <h3>Motion override</h3>
          <p class="hint">When a thermostat's built-in sensor detects people <strong>after hours</strong>, it switches to the occupied
            comfort settings for the hold time, then returns to schedule. Manual holds are never overridden by motion.</p>
          <label class="check"><input type="checkbox" data-motion="enabled"${d.motionRule.enabled ? ' checked' : ''}${dis}> Enable motion override</label>
          <label class="field">Hold for
            <select class="input" data-motion="holdMinutes"${dis}>${holdOpts.map(m =>
              `<option value="${m}"${m === d.motionRule.holdMinutes ? ' selected' : ''}>${m < 60 ? m + ' minutes' : (m / 60) + ' hour' + (m === 60 ? '' : 's')}</option>`).join('')}
            </select></label>
          <label class="check"><input type="checkbox" data-motion="extendOnMotion"${d.motionRule.extendOnMotion ? ' checked' : ''}${dis}> Restart the hold timer each time motion is seen</label>
        </div>

        <div class="card pad">
          <h3>Changes at the thermostat</h3>
          <p class="hint">When someone changes the temperature on a thermostat's screen, it keeps that setting (within the limit)
            for the set time, then returns to schedule. When off, the hub puts the schedule back within a minute.
            Mode changes are always put back, and holds set here in the dashboard always win.</p>
          <label class="check"><input type="checkbox" data-local="enabled"${d.localAdjust.enabled ? ' checked' : ''}${dis}> Allow temporary changes at the thermostat</label>
          <div class="form-grid">
            <label class="field">Keep the change for
              <select class="input" data-local="minutes"${dis}>${[15, 30, 60, 90, 120, 180, 240].map(m =>
                `<option value="${m}"${m === d.localAdjust.minutes ? ' selected' : ''}>${m < 60 ? m + ' minutes' : (m / 60) + ' hour' + (m === 60 ? '' : 's')}</option>`).join('')}
              </select></label>
            <label class="field">Allow up to
              <select class="input" data-local="maxDegrees"${dis}>${[1, 2, 3, 4, 5, 6, 8, 10].map(n =>
                `<option value="${n}"${n === d.localAdjust.maxDegrees ? ' selected' : ''}>${n}° warmer or cooler than the schedule</option>`).join('')}
              </select></label>
          </div>
        </div>

        <div class="card pad">
          <h3>Smart recovery</h3>
          <p class="hint">Starts heating or cooling just early enough to reach the occupied temperature right at opening time,
            based on how fast each thermostat's space actually warms or cools. Staggering spreads start times across
            thermostats in the same building so they don't all kick on at once (lower peak demand).</p>
          <label class="check"><input type="checkbox" data-recovery="enabled"${d.recovery.enabled ? ' checked' : ''}${dis}> Enable smart recovery</label>
          <div class="form-grid">
            <label class="field">Start no more than
              <select class="input" data-recovery="maxMinutes"${dis}>${[30, 60, 90, 120, 180, 240].map(m =>
                `<option value="${m}"${m === d.recovery.maxMinutes ? ' selected' : ''}>${m < 60 ? m + ' minutes' : (m / 60) + ' hour' + (m === 60 ? '' : 's')} early</option>`).join('')}
              </select></label>
            <label class="field">Stagger starts by up to
              <select class="input" data-recovery="staggerMinutes"${dis}>${[0, 10, 15, 20, 30, 45, 60].map(m =>
                `<option value="${m}"${m === d.recovery.staggerMinutes ? ' selected' : ''}>${m ? m + ' minutes' : 'No stagger'}</option>`).join('')}
              </select></label>
          </div>
        </div>

        <div class="card pad">
          <h3>Thermostats on this profile</h3>
          <p class="hint">Check thermostats to move them onto this profile when you save. To take one off, assign it a different profile.</p>
          ${assignHtml || '<p class="muted">No thermostats.</p>'}
        </div>

        ${canEdit || assignable ? `<div class="actions">
          <button class="btn primary" data-action="sched-save">${isNew ? 'Create profile' : canEdit ? 'Save' : 'Assign selected'}</button>
          <a class="btn ghost" href="#/schedules">Cancel</a>
          ${!isNew && Perm.canCreateSchedule(u, bizId) ? `<button class="btn ghost danger push-right" data-action="sched-delete" data-id="${id}">Delete profile</button>` : ''}
        </div>` : ''}`,
    };
  }

  // ---------- thermostat ----------
  function thermostatPage(id) {
    const t = S.thermostat(id), u = S.currentUser();
    if (!t) return notFound();
    const b = S.buildingOf(t);
    if (!Perm.canViewBuilding(u, b)) return notFound();
    const online = S.hubOnline(t);
    const canCtl = Perm.canControl(u, b) && online;
    const e = S.effective(t);
    const s = S.scheduleOf(t);
    const events = S.state.audit.filter(a => a.thermostatId === t.id).slice(0, 8);
    const modes = ['heat', 'cool', 'auto', 'off'];
    const motion = S.motionHistory(t.id);

    return {
      title: t.name, live: true,
      html: `
        <a class="back" href="#/building/${b.id}">← ${esc(b.name)}</a>
        <div class="page-head"><h1>${esc(t.name)}</h1><p class="sub">${esc(b.name)} · ${esc(t.model)}</p></div>
        ${online ? '' : `<div class="alert danger">Hub offline. Showing last known values.</div>`}
        ${online && t.offlineSince ? `<div class="alert danger"><strong>Not responding</strong> since ${UI.when(t.offlineSince)}.
          The hub can't reach this thermostat (power, Wi-Fi or network). Showing last known values.</div>` : ''}
        ${t.alert ? `<div class="alert danger"><strong>Thermostat alert</strong>${t.alertSince ? ` (since ${UI.when(t.alertSince)})` : ''}: ${esc(/[.!?…]$/.test(t.alert) ? t.alert : t.alert + '…')}</div>` : ''}
        <div class="tstat">
          <div class="card pad tstat-main">
            <div class="big-temp">${UI.temp(t.temp)}</div>
            <div class="tstat-meta">
              <div><span class="label">Humidity</span>${t.humidity == null ? '—' : t.humidity + '%'}</div>
              <div><span class="label">Target</span>${UI.temp(e.heat)} – ${UI.temp(e.cool)}</div>
              <div><span class="label">Equipment</span>${UI.equipBadge(t)}</div>
              <div><span class="label">Motion</span>${UI.motionDot(t)}</div>
            </div>
            <div class="tstat-status">${UI.holdBadge(e)}</div>
            <div class="label">Schedule profile</div>
            ${Perm.canAssignSchedule(u, b) ? scheduleSelect(t, `data-assign="${t.id}"`) : ''}
            ${s.id ? `<a href="#/schedules/${s.id}" class="small">${Perm.canAssignSchedule(u, b) ? 'View profile' : esc(s.name)}</a>` : ''}
            <p class="muted small">${esc(UI.hoursSummary(s.days))}</p>
            <div class="label">Smart recovery</div>
            <p class="small">${recoveryText(t, s, e)}</p>
          </div>
          <div class="card pad">
            <h3>Controls</h3>
            ${canCtl ? `
              <div class="label">Mode</div>
              <div class="seg">${modes.map(m => `<button class="${t.mode === m ? 'active' : ''}" data-action="set-mode" data-id="${t.id}" data-mode="${m}">${m}</button>`).join('')}</div>
              <div class="label">Temporary hold</div>
              <div class="steppers">
                ${stepper('heat', 'Heat to', e.heat)}
                ${stepper('cool', 'Cool to', e.cool)}
              </div>
              <label class="field">For
                <select class="input" id="hold-dur">
                  <option value="60">1 hour</option><option value="120" selected>2 hours</option>
                  <option value="240">4 hours</option><option value="next">Until next schedule change</option>
                  <option value="indefinite">Indefinitely</option>
                </select></label>
              <div class="actions">
                <button class="btn primary" data-action="hold" data-id="${t.id}">Apply hold</button>
                ${e.hold ? `<button class="btn" data-action="resume" data-id="${t.id}">Resume schedule</button>` : ''}
              </div>`
              : `<p class="muted">${online ? 'You have view-only access.' : 'Controls are unavailable while the hub is offline.'}</p>`}
          </div>
        </div>
        <div class="card pad">
          <h3>Motion, last 24 hours</h3>
          ${motion.loaded ? UI.motionTimeline(motion) : '<p class="muted">Loading motion history…</p>'}
        </div>
        ${Perm.isBusinessAdmin(u, t.businessId) ? `<div class="card pad">
          <h3>Name and building</h3>
          <div class="setup-row">
            <input class="input" id="tn-${t.id}" value="${esc(t.name)}" aria-label="Thermostat name">
            <select class="input" id="tb-${t.id}" aria-label="Building">${S.state.buildings.filter(x => x.businessId === t.businessId).map(x =>
              `<option value="${x.id}"${x.id === t.buildingId ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
            <button class="btn small primary" data-action="t-edit" data-id="${t.id}">Save</button>
          </div>
        </div>` : ''}
        <div class="card pad">
          <h3>Recent activity</h3>
          ${events.length ? `<ul class="list">${events.map(a =>
            `<li><span class="muted">${UI.timeAgo(a.ts)}</span> · ${esc(a.userName)}: ${esc(a.text)}</li>`).join('')}</ul>`
            : `<p class="muted">No changes yet.</p>`}
        </div>`,
    };
  }

  function recoveryText(t, s, e) {
    const rates = `<span class="muted">Learned: cools ~${t.rates.cool.toFixed(1)}°/hr, heats ~${t.rates.heat.toFixed(1)}°/hr.</span>`;
    if (!s.recovery.enabled) return 'Off for this profile. ' + rates;
    if (e.source === 'recovery') return `Running now, ready by ${UI.when(e.readyAt)}. ` + rates;
    const now = Date.now();
    if (S.isScheduledOccupied(s, new Date(now))) return 'Occupied now. ' + rates;
    const plan = S.recoveryPlan(t, now);
    if (!plan) return 'No upcoming occupied hours. ' + rates;
    return `Opens ${UI.when(plan.ready)}. Will start about ${UI.when(plan.start)} ` +
      `(${plan.recoverMin} min to reach temperature + ${plan.staggerMin} min stagger). ` + rates;
  }

  function stepper(key, label, val) {
    return `<div class="stepper"><span class="label">${label}</span>
      <button class="icon-btn" data-action="step" data-target="sp-${key}" data-delta="-1">−</button>
      <input type="number" class="input num-input" id="sp-${key}" value="${Math.round(val)}" min="45" max="95">
      <button class="icon-btn" data-action="step" data-target="sp-${key}" data-delta="1">+</button></div>`;
  }

  // ---------- users ----------
  function usersPage() {
    const u = S.currentUser();
    const bizList = S.visibleBusinesses().filter(biz => Perm.canManageUsers(u, biz.id));
    if (!bizList.length) return notFound();

    const sections = bizList.map(biz => {
      const users = S.state.users.filter(x => x.businessId === biz.id);
      const blds = S.state.buildings.filter(x => x.businessId === biz.id);
      const editing = userDraft && userDraft.businessId === biz.id;
      return `<section class="section card pad">
        <div class="row-between"><h2 class="section-title">${esc(biz.name)}</h2>
          ${editing ? '' : `<button class="btn small" data-action="user-new" data-biz="${biz.id}">+ Add user</button>`}</div>
        <p class="hint">Users sign in with their Microsoft 365 account (${esc(biz.tenantDomain)}).</p>
        ${editing ? userForm(blds) : ''}
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Buildings</th><th></th></tr></thead>
          <tbody>${users.map(x => `<tr>
            <td>${esc(x.name)}</td><td>${esc(x.email)}</td><td>${esc(Perm.ROLES[x.role])}</td>
            <td>${x.role === 'business_admin' || !x.buildingIds.length ? 'All' : x.buildingIds.map(id => esc(S.building(id).name)).join(', ')}</td>
            <td class="nowrap right">
              <button class="btn small ghost" data-action="user-edit" data-id="${x.id}">Edit</button>
              ${x.id !== u.id ? `<button class="btn small ghost danger" data-action="user-remove" data-id="${x.id}">Remove</button>` : ''}
            </td></tr>`).join('')}</tbody></table></div>
      </section>`;
    }).join('');

    return {
      title: 'Users',
      html: `<div class="page-head"><h1>Users & permissions</h1>
        <p class="sub">Business Admins manage everything in their business. Building Managers control and schedule their assigned buildings. Viewers can only look.</p></div>${sections}`,
    };
  }

  function userForm(blds) {
    const d = userDraft;
    const roles = Perm.assignableRoles(S.currentUser());
    const scoped = d.role !== 'business_admin';
    return `<div class="user-form">
      <h3>${d.id ? 'Edit user' : 'Add user'}</h3>
      <div class="form-grid">
        <label class="field">Name<input class="input" id="uf-name" value="${esc(d.name)}"></label>
        <label class="field">Work email<input class="input" id="uf-email" type="email" value="${esc(d.email)}"></label>
        <label class="field">Role<select class="input" id="uf-role">${roles.map(r =>
          `<option value="${r}"${r === d.role ? ' selected' : ''}>${Perm.ROLES[r]}</option>`).join('')}</select></label>
      </div>
      ${scoped ? `<div class="label">Buildings (none checked = all buildings)</div>
        <div class="checks">${blds.map(b => `<label class="check"><input type="checkbox" data-uf-bld="${b.id}"${d.buildingIds.includes(b.id) ? ' checked' : ''}> ${esc(b.name)}</label>`).join('')}</div>` : ''}
      <div class="actions">
        <button class="btn primary" data-action="user-save">Save</button>
        <button class="btn ghost" data-action="user-cancel">Cancel</button>
      </div></div>`;
  }

  // ---------- setup: businesses, hubs, buildings, new thermostats ----------
  let shownToken = null;   // { bizId, token } — a new hub token is displayed once

  function setupPage() {
    const u = S.currentUser();
    const list = S.visibleBusinesses().filter(biz => Perm.isBusinessAdmin(u, biz.id));
    if (!list.length && !Perm.isPlatform(u)) return notFound();
    const addBiz = Perm.isPlatform(u) ? `<div class="card pad">
        <h3>Add a business</h3>
        <p class="hint">The tenant ID is in the business's Microsoft Entra admin center (Overview → Tenant ID).
          After adding the business, add its first Business Admin on the Users page.</p>
        <div class="form-grid">
          <label class="field">Business name<input class="input" id="nb-name"></label>
          <label class="field">Microsoft 365 tenant ID<input class="input" id="nb-tenant" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"></label>
          <label class="field">Email domain<input class="input" id="nb-domain" placeholder="example.com"></label>
        </div>
        <div class="actions"><button class="btn primary" data-action="biz-create">Add business</button></div>
      </div>` : '';
    return {
      title: 'Setup', live: true,
      html: `<div class="page-head"><h1>Setup</h1>
        <p class="sub">Each business has one hub (Home Assistant on the onsite admin PC) that talks to its thermostats locally
          and checks in with ThermoHub every few seconds.</p></div>${addBiz}${list.map(bizSetup).join('')}`,
    };
  }

  function bizSetup(biz) {
    const blds = S.state.buildings.filter(b => b.businessId === biz.id);
    const unplaced = S.unplacedIn(biz.id);
    const count = S.state.thermostats.filter(t => t.businessId === biz.id).length;
    const token = shownToken && shownToken.bizId === biz.id ? shownToken.token : null;
    const hubBadge = biz.hub.online ? badge('Hub online', 'ok') : biz.hub.paired ? badge('Hub offline', 'danger') : badge('No hub yet', 'muted');
    return `<section class="section card pad">
      <div class="row-between"><h2 class="section-title">${esc(biz.name)}</h2>${hubBadge}</div>

      <h3>Hub</h3>
      <ul class="list plain">
        <li><span class="label">Last seen</span> ${UI.timeAgo(biz.hub.lastSeen)}</li>
        <li><span class="label">Software</span> ${esc(biz.hub.version)}</li>
        <li><span class="label">Thermostats</span> ${count}</li>
      </ul>
      ${token ? `<div class="alert info"><strong>Hub token — copy it now, it won't be shown again:</strong>
        <code class="token">${esc(token)}</code>Enter it in the hub's ThermoHub settings. Issuing a new token disconnects the old hub.</div>` : ''}
      <div class="actions">
        <button class="btn small" data-action="hub-pair" data-biz="${biz.id}">${biz.hub.paired ? 'Issue new hub token' : 'Pair a hub'}</button>
        ${CONFIG.DEMO_MODE ? `<button class="btn small ghost" data-action="hub-toggle" data-biz="${biz.id}">Demo: take hub ${biz.hub.online ? 'offline' : 'online'}</button>` : ''}
      </div>

      <h3>Buildings</h3>
      <div class="setup-list">${blds.map(b => {
        const n = S.thermostatsIn(b.id).length;
        return `<div class="setup-row">
          <input class="input" id="bn-${b.id}" value="${esc(b.name)}" aria-label="Building name">
          <button class="btn small" data-action="bld-rename" data-id="${b.id}">Rename</button>
          <span class="muted small">${plural(n, 'thermostat')}</span>
          ${n ? '' : `<button class="btn small ghost danger" data-action="bld-delete" data-id="${b.id}">Delete</button>`}
        </div>`;
      }).join('') || '<p class="muted">No buildings yet.</p>'}</div>
      <div class="setup-row">
        <input class="input" id="nbld-${biz.id}" placeholder="New building name" aria-label="New building name">
        <button class="btn small" data-action="bld-create" data-biz="${biz.id}">Add building</button>
      </div>

      <h3>New thermostats</h3>
      ${unplaced.length ? `<p class="hint">Found by the hub. Name each one and choose its building, then give it a schedule profile.</p>
        <div class="setup-list">${unplaced.map(t => `<div class="setup-row">
          <input class="input" id="tn-${t.id}" value="${esc(t.name)}" aria-label="Thermostat name">
          <select class="input" id="tb-${t.id}" aria-label="Building"><option value="">Choose building…</option>
            ${blds.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>
          <button class="btn small primary" data-action="t-place" data-id="${t.id}">Save</button>
        </div>`).join('')}</div>`
        : '<p class="muted">None waiting. Thermostats the hub finds will appear here.</p>'}
    </section>`;
  }

  // ---------- activity ----------
  function activityPage() {
    const ids = S.visibleBusinesses().map(b => b.id);
    const multi = ids.length > 1;
    const entries = S.state.audit.filter(a => ids.includes(a.businessId)).slice(0, 200);
    return {
      title: 'Activity', live: true,
      html: `<div class="page-head"><h1>Activity</h1><p class="sub">Every change and motion override, newest first.</p></div>
        <div class="card pad">${entries.length ? `<ul class="list">${entries.map(a =>
          `<li><span class="muted nowrap">${new Date(a.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
            · <strong>${esc(a.userName)}</strong>${multi ? ` <span class="muted">(${esc(S.business(a.businessId).name)})</span>` : ''}: ${esc(a.text)}</li>`).join('')}</ul>`
          : `<p class="muted">Nothing yet. Changes and motion overrides will show here.</p>`}</div>`,
    };
  }

  // ---------- event handlers (called by app.js via data-action) ----------
  const val = id => document.getElementById(id).value;
  // Handlers may be async (live mode calls the API); app.js awaits them and shows errors.
  const handlers = {
    'resume-building': async el => { await S.actions.resumeBuilding(el.dataset.id); UI.toast('Schedule resumed on all thermostats'); },
    'set-mode': async el => { await S.actions.setMode(el.dataset.id, el.dataset.mode); UI.toast('Mode set to ' + el.dataset.mode); },
    'step': el => {
      const input = document.getElementById(el.dataset.target);
      input.value = Number(input.value) + Number(el.dataset.delta);
      return 'dirty';
    },
    'hold': async el => {
      await S.actions.setHold(el.dataset.id, Number(val('sp-heat')), Number(val('sp-cool')), val('hold-dur'));
      UI.toast('Hold applied');
    },
    'resume': async el => { await S.actions.resumeSchedule(el.dataset.id); UI.toast('Back on schedule'); },
    'assign-all': async el => {
      const sId = val('bulk-sched');
      const n = await S.actions.assignSchedule(S.thermostatsIn(el.dataset.id).map(t => t.id), sId);
      UI.toast(n ? `${plural(n, 'thermostat')} moved to ${S.schedule(sId).name}` : 'All thermostats already use that profile');
    },

    'sched-add': el => {
      const list = schedDraft.data.days[el.dataset.day];
      const last = list[list.length - 1];
      list.push(last ? { start: last.end, end: '23:59' } : { start: '08:00', end: '17:00' });
      return 'rerender';
    },
    'sched-remove': el => { schedDraft.data.days[el.dataset.day].splice(Number(el.dataset.idx), 1); return 'rerender'; },
    'sched-copy-weekdays': () => {
      ['tue', 'wed', 'thu', 'fri'].forEach(d => { schedDraft.data.days[d] = clone(schedDraft.data.days.mon); });
      return 'rerender';
    },
    'sched-save': async () => {
      const d = schedDraft;
      let id = d.id, msg;
      if (id !== 'new' && !S.canEditSchedule(S.schedule(id)) && !d.addIds.length) throw new Error('Check at least one thermostat to assign.');
      if (id === 'new') {
        id = await S.actions.createSchedule(d.businessId, clone(d.data));
        msg = `Created "${d.data.name.trim()}"`;
      } else if (S.canEditSchedule(S.schedule(id))) {
        await S.actions.saveSchedule(id, clone(d.data));
        msg = 'Schedule saved';
      }
      const n = d.addIds.length ? await S.actions.assignSchedule(d.addIds, id) : 0;
      if (!msg && !n) throw new Error('Check at least one thermostat to assign.');
      UI.toast([msg, n ? `${plural(n, 'thermostat')} assigned` : ''].filter(Boolean).join(' · '));
      schedDraft = null;
      if (d.id === 'new') location.hash = '#/schedules/' + id;
      else return 'rerender';
    },
    'sched-delete': async el => {
      if (el.dataset.confirm !== 'yes') {
        if (S.thermostatsUsing(el.dataset.id).length) throw new Error('Assign its thermostats to another profile before deleting.');
        el.dataset.confirm = 'yes'; el.textContent = 'Click again to delete'; return 'dirty';
      }
      await S.actions.deleteSchedule(el.dataset.id);
      UI.toast('Profile deleted');
      location.hash = '#/schedules';
    },

    'user-new': el => { userDraft = { id: null, businessId: el.dataset.biz, name: '', email: '', role: 'viewer', buildingIds: [] }; return 'rerender'; },
    'user-edit': el => { userDraft = clone(S.user(el.dataset.id)); return 'rerender'; },
    'user-cancel': () => { userDraft = null; return 'rerender'; },
    'user-save': async () => {
      const role = val('uf-role');
      const data = {
        ...userDraft, name: val('uf-name').trim(), email: val('uf-email').trim(), role,
        buildingIds: role === 'business_admin' ? [] : [...document.querySelectorAll('[data-uf-bld]:checked')].map(c => c.dataset.ufBld),
      };
      if (!data.name) throw new Error('Enter a name.');
      const draft = userDraft;
      userDraft = null;
      try { await S.actions.saveUser(data); } catch (e) { userDraft = draft; throw e; }
      UI.toast('User saved');
    },
    'user-remove': async el => {
      const x = S.user(el.dataset.id);
      if (el.dataset.confirm !== 'yes') { el.dataset.confirm = 'yes'; el.textContent = 'Click again to remove'; return 'dirty'; }
      await S.actions.removeUser(x.id);
      UI.toast('Removed ' + x.email);
    },

    'hub-toggle': el => { const biz = S.business(el.dataset.biz); S.actions.setHubOnline(biz.id, !biz.hub.online); },
    'hub-pair': async el => {
      const bizId = el.dataset.biz;
      if (S.business(bizId).hub.paired && el.dataset.confirm !== 'yes') {
        el.dataset.confirm = 'yes'; el.textContent = 'Click again: the current hub will be disconnected'; return 'dirty';
      }
      const token = await S.actions.pairHub(bizId);
      shownToken = { bizId, token };
      return 'rerender';
    },
    'biz-create': async () => {
      await S.actions.createBusiness({ name: val('nb-name').trim(), tenantId: val('nb-tenant').trim().toLowerCase(),
        tenantDomain: val('nb-domain').trim().toLowerCase() });
      UI.toast('Business added. Next: add its first Business Admin on the Users page.');
    },
    'bld-create': async el => {
      await S.actions.createBuilding(el.dataset.biz, val('nbld-' + el.dataset.biz).trim());
      UI.toast('Building added');
    },
    'bld-rename': async el => { await S.actions.updateBuilding(el.dataset.id, val('bn-' + el.dataset.id).trim()); UI.toast('Building renamed'); },
    'bld-delete': async el => {
      if (el.dataset.confirm !== 'yes') { el.dataset.confirm = 'yes'; el.textContent = 'Click again to delete'; return 'dirty'; }
      await S.actions.deleteBuilding(el.dataset.id);
      UI.toast('Building deleted');
    },
    't-place': async el => {
      const id = el.dataset.id;
      const buildingId = val('tb-' + id);
      if (!buildingId) throw new Error('Choose a building.');
      await S.actions.updateThermostat(id, { name: val('tn-' + id).trim(), buildingId });
      UI.toast('Thermostat placed. Give it a schedule profile on the building’s Schedules tab.');
    },
    't-edit': async el => {
      const id = el.dataset.id;
      const name = val('tn-' + id).trim();
      if (!name) throw new Error('Enter a name.');
      await S.actions.updateThermostat(id, { name, buildingId: val('tb-' + id) });
      UI.toast('Thermostat saved');
      return 'rerender';
    },
  };

  // Keep drafts in sync with typed input; some inputs act immediately.
  function onInput(el) {
    const ds = el.dataset;
    if (ds.assign) {
      if (!el.value) return;
      const name = S.thermostat(ds.assign).name;
      return Promise.resolve(S.actions.assignSchedule([ds.assign], el.value))
        .then(() => { UI.toast(`${name} now follows ${S.schedule(el.value).name}`); });
    }
    if (schedDraft) {
      const d = schedDraft.data;
      if (el.id === 'sd-name') d.name = el.value;
      else if (ds.sched) { const [k, f] = ds.sched.split('.'); d[k][f] = Number(el.value); }
      else if (ds.day) d.days[ds.day][Number(ds.idx)][ds.key] = el.value;
      else if (ds.motion) d.motionRule[ds.motion] = el.type === 'checkbox' ? el.checked : Number(el.value);
      else if (ds.recovery) d.recovery[ds.recovery] = el.type === 'checkbox' ? el.checked : Number(el.value);
      else if (ds.local) d.localAdjust[ds.local] = el.type === 'checkbox' ? el.checked : Number(el.value);
      else if (ds.addT) {
        schedDraft.addIds = schedDraft.addIds.filter(x => x !== ds.addT);
        if (el.checked) schedDraft.addIds.push(ds.addT);
      }
      return;
    }
    if (userDraft && el.id === 'uf-role') {
      userDraft.name = val('uf-name'); userDraft.email = val('uf-email'); userDraft.role = el.value;
      userDraft.buildingIds = [...document.querySelectorAll('[data-uf-bld]:checked')].map(c => c.dataset.ufBld);
      return 'rerender';
    }
  }

  function resetDrafts() { schedDraft = null; userDraft = null; shownToken = null; }

  return { overview, buildingPage, schedulesPage, scheduleEditPage, thermostatPage, usersPage, setupPage, activityPage,
    handlers, onInput, resetDrafts };
})();
