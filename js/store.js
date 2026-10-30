// App state and shared schedule logic.
// Demo mode: local simulated data. Live mode: data from the ThermoHub API, refreshed by polling.
window.Store = (function () {
  const KEY = 'thermohub-demo';
  const VERSION = 4;
  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const DEMO = CONFIG.DEMO_MODE;
  const listeners = [];
  let state = DEMO ? (load() || DemoData.create()) : { selectedBusinessId: null };

  // Stand-in for thermostats not yet assigned a profile: no hours, no automation.
  const NO_SCHEDULE = {
    id: null, name: 'No schedule', occupied: { heat: null, cool: null }, unoccupied: { heat: null, cool: null },
    days: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    motionRule: { enabled: false, holdMinutes: 120, extendOnMotion: true },
    recovery: { enabled: false, maxMinutes: 120, staggerMinutes: 0 },
    localAdjust: { enabled: false, minutes: 60, maxDegrees: 3 },
  };
  // Changes at the thermostat screen, for profiles saved before this setting existed.
  const DEFAULT_LOCAL_ADJUST = { enabled: true, minutes: 60, maxDegrees: 3 };
  const localAdjustOf = s => s.localAdjust || DEFAULT_LOCAL_ADJUST;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const s = raw ? JSON.parse(raw) : null;
      return s && s.version === VERSION ? s : null;
    } catch (e) { return null; }
  }
  function save() {
    if (!DEMO) return;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
  }
  function emit(kind) { save(); listeners.forEach(fn => fn(kind)); }

  // ---------- lookups ----------
  const byId = (list, id) => list.find(x => x.id === id);
  const business = id => byId(state.businesses, id);
  const building = id => byId(state.buildings, id);
  const thermostat = id => byId(state.thermostats, id);
  const schedule = id => byId(state.schedules, id);
  const user = id => byId(state.users, id);
  const currentUser = () => (DEMO ? user(state.currentUserId) : state.me);
  const buildingOf = t => building(t.buildingId);
  const businessOf = b => business(b.businessId);
  const scheduleOf = t => schedule(t.scheduleId) || NO_SCHEDULE;
  const thermostatsIn = bId => state.thermostats.filter(t => t.buildingId === bId);
  const unplacedIn = bizId => state.thermostats.filter(t => t.businessId === bizId && !t.buildingId);
  const thermostatsUsing = sId => state.thermostats.filter(t => t.scheduleId === sId);
  const buildingsUsing = sId => [...new Set(thermostatsUsing(sId).filter(t => t.buildingId).map(t => t.buildingId))].map(building);
  const schedulesFor = bizId => state.schedules.filter(s => s.businessId === bizId);

  function visibleBusinesses() {
    const u = currentUser();
    const sel = state.selectedBusinessId;
    return state.businesses.filter(b => Perm.canViewBusiness(u, b.id) && (sel === 'all' || b.id === sel));
  }
  function visibleBuildings() {
    const u = currentUser();
    const sel = state.selectedBusinessId;
    return state.buildings.filter(b =>
      Perm.canViewBuilding(u, b) && (sel === 'all' || !Perm.isPlatform(u) || b.businessId === sel));
  }

  // ---------- schedule logic ----------
  const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

  function isScheduledOccupied(sched, date) {
    const periods = sched.days[DAY_KEYS[date.getDay()]] || [];
    const now = date.getHours() * 60 + date.getMinutes();
    return periods.some(p => now >= toMin(p.start) && now < toMin(p.end));
  }

  // Next time the schedule switches between occupied/unoccupied (searches 7 days).
  function nextScheduleChange(sched, from) {
    const start = isScheduledOccupied(sched, from);
    const d = new Date(from);
    d.setSeconds(0, 0);
    for (let i = 0; i < 7 * 24 * 4; i++) {
      d.setMinutes(d.getMinutes() + 15 - (d.getMinutes() % 15));
      if (isScheduledOccupied(sched, d) !== start) return d.getTime();
    }
    return null;
  }

  // 'open' | 'closed' | 'partial' — based on each thermostat's profile.
  function buildingOpenState(bId) {
    const now = new Date();
    const ts = thermostatsIn(bId);
    const open = ts.filter(t => isScheduledOccupied(scheduleOf(t), now)).length;
    return open === 0 ? 'closed' : open === ts.length ? 'open' : 'partial';
  }

  function activeHold(t) {
    if (!t.hold) return null;
    if (t.hold.until && t.hold.until <= Date.now()) return null;
    return t.hold;
  }

  // Spread start times across a building's thermostats (one electric meter per building, usually):
  // the first starts on time, the last starts up to staggerMinutes earlier.
  function staggerOffset(t, staggerMinutes) {
    const ts = thermostatsIn(t.buildingId);
    const n = ts.length;
    return n > 1 ? Math.round(ts.findIndex(x => x.id === t.id) / (n - 1) * staggerMinutes) : 0;
  }

  // When smart recovery should start so the thermostat reaches the occupied target by opening.
  // Returns null when recovery doesn't apply (disabled, already occupied, mode off).
  function recoveryPlan(t, now) {
    const s = scheduleOf(t), r = s.recovery;
    if (!r || !r.enabled || t.mode === 'off' || t.temp == null || isScheduledOccupied(s, new Date(now))) return null;
    const ready = nextScheduleChange(s, new Date(now));
    if (!ready) return null;
    const p = s.occupied;
    let deg = 0, rate = 1;
    if (t.temp > p.cool && t.mode !== 'heat') { deg = t.temp - p.cool; rate = t.rates.cool; }
    else if (t.temp < p.heat && t.mode !== 'cool') { deg = p.heat - t.temp; rate = t.rates.heat; }
    const recoverMin = Math.min(r.maxMinutes, Math.ceil(deg / rate * 60));
    const staggerMin = staggerOffset(t, r.staggerMinutes);
    return { ready, recoverMin, staggerMin, start: ready - (recoverMin + staggerMin) * 60000 };
  }

  function isRecovering(t) { return !!t.recovering && Date.now() < t.recovering; }

  // What the thermostat is targeting right now, and why.
  function effective(t) {
    const hold = activeHold(t);
    if (hold) return { heat: hold.heat, cool: hold.cool, source: hold.type, hold };
    const s = scheduleOf(t);
    const occ = isScheduledOccupied(s, new Date());
    if (!occ && isRecovering(t)) return { heat: s.occupied.heat, cool: s.occupied.cool, source: 'recovery', readyAt: t.recovering, hold: null };
    const p = occ ? s.occupied : s.unoccupied;
    return { heat: p.heat, cool: p.cool, source: occ ? 'occupied' : 'unoccupied', hold: null };
  }

  function hubOnline(t) { return business(t.businessId).hub.online; }

  // duration: minutes, 'next' (until next schedule change), or 'indefinite'
  function holdUntil(t, duration) {
    if (duration === 'next') return nextScheduleChange(scheduleOf(t), new Date());
    if (duration === 'indefinite') return null;
    return Date.now() + Number(duration) * 60000;
  }

  function canEditSchedule(s) {
    return Perm.canEditSchedule(currentUser(), s, buildingsUsing(s.id));
  }

  // ---------- demo: audit + mutations ----------
  function log(businessId, text, thermostatId, who) {
    const u = currentUser();
    state.audit.unshift({ ts: Date.now(), businessId, userName: who || (u ? u.name : 'System'), text, thermostatId: thermostatId || null });
    if (state.audit.length > 500) state.audit.length = 500;
  }

  const labelOf = t => (t.buildingId ? buildingOf(t).name + ' / ' : '') + t.name;

  function requireControl(t) {
    const u = currentUser();
    const ok = t.buildingId ? Perm.canControl(u, buildingOf(t)) : Perm.isBusinessAdmin(u, t.businessId);
    if (!ok) throw new Error('You do not have permission to control this thermostat.');
  }
  function requireAdmin(bizId) {
    if (!Perm.isBusinessAdmin(currentUser(), bizId)) throw new Error('Only Business Admins can do that.');
  }

  function validateSchedule(s) {
    if (!s.name || !s.name.trim()) throw new Error('Give the schedule a name.');
    ['occupied', 'unoccupied'].forEach(k => {
      const p = s[k];
      if (!(p.heat >= 45 && p.heat <= 90 && p.cool >= 50 && p.cool <= 95)) throw new Error('Setpoints must be between 45° and 95°.');
      if (p.cool - p.heat < 2) throw new Error('Cool setpoint must be at least 2° above heat setpoint.');
    });
    Object.values(s.days).forEach(periods => periods.forEach(p => {
      if (!p.start || !p.end || toMin(p.end) <= toMin(p.start)) throw new Error('Each occupied period must end after it starts.');
    }));
    const m = s.motionRule.holdMinutes;
    if (!(m >= 15 && m <= 720)) throw new Error('Motion hold time must be 15–720 minutes.');
    const r = s.recovery;
    if (!(r.maxMinutes >= 15 && r.maxMinutes <= 240)) throw new Error('Recovery can start 15–240 minutes early.');
    if (!(r.staggerMinutes >= 0 && r.staggerMinutes <= 60)) throw new Error('Stagger must be 0–60 minutes.');
    const l = s.localAdjust;
    if (!(l.minutes >= 15 && l.minutes <= 480)) throw new Error('Changes at the thermostat can last 15–480 minutes.');
    if (!(l.maxDegrees >= 1 && l.maxDegrees <= 10)) throw new Error('Changes at the thermostat can be limited to 1°–10°.');
  }

  const demoActions = {
    switchUser(id) {
      state.currentUserId = id;
      const u = currentUser();
      state.selectedBusinessId = Perm.isPlatform(u) ? 'all' : u.businessId;
      emit('user');
    },
    selectBusiness(id) { state.selectedBusinessId = id; emit('ui'); },

    setMode(tId, mode) {
      const t = thermostat(tId);
      requireControl(t);
      t.mode = mode;
      log(t.businessId, `Set ${labelOf(t)} mode to ${mode}`, tId);
      emit('data');
    },

    setHold(tId, heat, cool, duration) {
      const t = thermostat(tId);
      requireControl(t);
      if (cool - heat < 2) throw new Error('Cool setpoint must be at least 2° above heat setpoint.');
      const until = holdUntil(t, duration);
      t.hold = { type: 'manual', heat, cool, until, by: currentUser().name };
      log(t.businessId, `Hold ${labelOf(t)} at ${heat}°–${cool}°` +
        (until ? ` until ${new Date(until).toLocaleString()}` : ' indefinitely'), tId);
      emit('data');
    },

    resumeSchedule(tId) {
      const t = thermostat(tId);
      requireControl(t);
      t.hold = null;
      log(t.businessId, `Resumed schedule on ${labelOf(t)}`, tId);
      emit('data');
    },

    resumeBuilding(bId) {
      const b = building(bId);
      if (!Perm.canControl(currentUser(), b)) throw new Error('You do not have permission to control this building.');
      thermostatsIn(bId).forEach(t => { t.hold = null; });
      log(b.businessId, `Resumed schedule on all thermostats in ${b.name}`);
      emit('data');
    },

    // Point thermostats at a schedule profile. Skips any the user can't control.
    assignSchedule(tIds, sId) {
      const s = schedule(sId);
      const u = currentUser();
      let n = 0;
      tIds.forEach(id => {
        const t = thermostat(id);
        const ok = t.buildingId ? Perm.canAssignSchedule(u, buildingOf(t)) : Perm.isBusinessAdmin(u, t.businessId);
        if (t.businessId !== s.businessId || !ok || t.scheduleId === sId) return;
        t.scheduleId = sId;
        n++;
      });
      if (n) log(s.businessId, `Assigned ${n} thermostat${n === 1 ? '' : 's'} to "${s.name}"`);
      emit('data');
      return n;
    },

    createSchedule(bizId, data) {
      if (!Perm.canCreateSchedule(currentUser(), bizId)) throw new Error('Only Business Admins can create schedules.');
      validateSchedule(data);
      const s = { ...data, id: 'sch-' + Date.now(), businessId: bizId, name: data.name.trim() };
      state.schedules.push(s);
      log(bizId, `Created schedule "${s.name}"`);
      emit('data');
      return s.id;
    },

    saveSchedule(sId, data) {
      const s = schedule(sId);
      if (!canEditSchedule(s)) throw new Error('No permission to edit this schedule.');
      validateSchedule(data);
      Object.assign(s, { name: data.name.trim(), occupied: data.occupied, unoccupied: data.unoccupied,
        days: data.days, motionRule: data.motionRule, recovery: data.recovery, localAdjust: data.localAdjust });
      log(s.businessId, `Updated schedule "${s.name}" (${thermostatsUsing(sId).length} thermostats)`);
      emit('data');
    },

    deleteSchedule(sId) {
      const s = schedule(sId);
      if (!Perm.canCreateSchedule(currentUser(), s.businessId)) throw new Error('Only Business Admins can delete schedules.');
      const n = thermostatsUsing(sId).length;
      if (n) throw new Error(`${n} thermostat${n === 1 ? ' still uses' : 's still use'} this schedule. Assign them another one first.`);
      state.schedules = state.schedules.filter(x => x.id !== sId);
      log(s.businessId, `Deleted schedule "${s.name}"`);
      emit('data');
    },

    saveUser(data) {
      const u = currentUser();
      const bizId = data.businessId;
      if (!Perm.canManageUsers(u, bizId)) throw new Error('No permission to manage users.');
      if (!Perm.assignableRoles(u).includes(data.role)) throw new Error('You cannot assign that role.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) throw new Error('Enter a valid email address.');
      let target = data.id ? user(data.id) : null;
      if (target) {
        Object.assign(target, { name: data.name, email: data.email, role: data.role, buildingIds: data.buildingIds });
        log(bizId, `Updated user ${data.email} (${Perm.ROLES[data.role]})`);
      } else {
        if (state.users.some(x => x.email.toLowerCase() === data.email.toLowerCase())) throw new Error('A user with that email already exists.');
        target = { id: 'u-' + Date.now(), businessId: bizId, name: data.name, email: data.email, role: data.role, buildingIds: data.buildingIds };
        state.users.push(target);
        log(bizId, `Added user ${data.email} (${Perm.ROLES[data.role]})`);
      }
      emit('data');
    },

    removeUser(id) {
      const target = user(id);
      if (!Perm.canManageUsers(currentUser(), target.businessId)) throw new Error('No permission to manage users.');
      if (target.id === state.currentUserId) throw new Error('You cannot remove yourself.');
      state.users = state.users.filter(x => x.id !== id);
      log(target.businessId, `Removed user ${target.email}`);
      emit('data');
    },

    createBusiness(data) {
      if (!Perm.isPlatform(currentUser())) throw new Error('Only platform admins can add businesses.');
      if (!data.name) throw new Error('Enter a business name.');
      if (!/^[0-9a-f-]{36}$/i.test(data.tenantId)) throw new Error('Enter the Microsoft 365 tenant ID (a GUID).');
      const id = 'biz-' + Date.now();
      state.businesses.push({ id, name: data.name, tenantDomain: data.tenantDomain, tenantId: data.tenantId,
        hub: { online: false, lastSeen: null, version: 'not connected', paired: false } });
      log(id, `Created business "${data.name}"`);
      emit('data');
      return id;
    },

    pairHub(bizId) {
      requireAdmin(bizId);
      const biz = business(bizId);
      biz.hub.paired = true;
      log(bizId, 'Issued a new hub token');
      emit('data');
      return 'demo-' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
    },

    createBuilding(bizId, name) {
      requireAdmin(bizId);
      if (!name) throw new Error('Enter a building name.');
      state.buildings.push({ id: 'bld-' + Date.now(), businessId: bizId, name });
      log(bizId, `Added building "${name}"`);
      emit('data');
    },

    updateBuilding(id, name) {
      const b = building(id);
      requireAdmin(b.businessId);
      if (!name) throw new Error('Enter a building name.');
      log(b.businessId, `Renamed building "${b.name}" to "${name}"`);
      b.name = name;
      emit('data');
    },

    deleteBuilding(id) {
      const b = building(id);
      requireAdmin(b.businessId);
      if (thermostatsIn(id).length) throw new Error('Move or remove this building’s thermostats first.');
      state.buildings = state.buildings.filter(x => x.id !== id);
      state.users.forEach(u => { u.buildingIds = u.buildingIds.filter(x => x !== id); });
      log(b.businessId, `Deleted building "${b.name}"`);
      emit('data');
    },

    updateThermostat(id, data) {
      const t = thermostat(id);
      requireAdmin(t.businessId);
      if (data.name !== undefined) t.name = data.name || t.name;
      if (data.buildingId !== undefined) t.buildingId = data.buildingId || null;
      log(t.businessId, `Updated thermostat "${t.name}"`, id);
      emit('data');
    },

    setHubOnline(bizId, online) {
      const biz = business(bizId);
      biz.hub.online = online;
      if (online) biz.hub.lastSeen = Date.now();
      log(bizId, `Demo: hub marked ${online ? 'online' : 'offline'}`);
      emit('data');
    },

    resetDemo() {
      state = DemoData.create();
      emit('reset');
    },
  };

  // ---------- live: API-backed mutations ----------
  async function refresh() {
    const s = await Api.call('GET', '/api/state');
    const sel = state.selectedBusinessId || (Perm.isPlatform(s.user) ? 'all' : s.user.businessId);
    state = { ...s, me: s.user, selectedBusinessId: sel };
  }

  // Wraps an API call: run it, reload state, re-render, return its result.
  const live = fn => async (...args) => {
    const result = await fn(...args);
    await refresh();
    emit('data');
    return result;
  };

  const liveActions = {
    switchUser() {},
    selectBusiness(id) { state.selectedBusinessId = id; emit('ui'); },
    setMode: live((id, mode) => Api.call('POST', `/api/thermostats/${id}/mode`, { mode })),
    setHold: live((id, heat, cool, duration) =>
      Api.call('POST', `/api/thermostats/${id}/hold`, { heat, cool, until: holdUntil(thermostat(id), duration) })),
    resumeSchedule: live(id => Api.call('POST', `/api/thermostats/${id}/resume`)),
    resumeBuilding: live(id => Api.call('POST', `/api/buildings/${id}/resume`)),
    assignSchedule: live((thermostatIds, scheduleId) =>
      Api.call('POST', '/api/schedules/assign', { thermostatIds, scheduleId }).then(r => r.assigned)),
    createSchedule: live((businessId, data) => Api.call('POST', '/api/schedules', { businessId, data }).then(r => r.id)),
    saveSchedule: live((id, data) => Api.call('PUT', `/api/schedules/${id}`, { data })),
    deleteSchedule: live(id => Api.call('DELETE', `/api/schedules/${id}`)),
    saveUser: live(d => (d.id ? Api.call('PUT', `/api/users/${d.id}`, d) : Api.call('POST', '/api/users', d))),
    removeUser: live(id => Api.call('DELETE', `/api/users/${id}`)),
    createBusiness: live(d => Api.call('POST', '/api/businesses', d).then(r => r.id)),
    pairHub: live(bizId => Api.call('POST', `/api/businesses/${bizId}/hub-token`).then(r => r.token)),
    createBuilding: live((businessId, name) => Api.call('POST', '/api/buildings', { businessId, name })),
    updateBuilding: live((id, name) => Api.call('PUT', `/api/buildings/${id}`, { name })),
    deleteBuilding: live(id => Api.call('DELETE', `/api/buildings/${id}`)),
    updateThermostat: live((id, data) => Api.call('PUT', `/api/thermostats/${id}`, data)),
    setHubOnline() {},
    resetDemo() {},
  };

  // ---------- demo simulation ----------
  // Motion outside the profile's occupied hours -> hold its occupied comfort setting.
  // Manual holds and changes at the thermostat are never overridden by motion. (In live mode the hub runs this.)
  function applyMotionRule(t, now) {
    const s = scheduleOf(t);
    const rule = s.motionRule;
    if (!rule.enabled || !t.occupied) return;
    if (isScheduledOccupied(s, new Date(now))) return;
    const hold = activeHold(t);
    const until = now + rule.holdMinutes * 60000;
    if (hold && hold.type === 'motion') {
      if (rule.extendOnMotion) hold.until = until;
      return;
    }
    if (hold) return;
    t.hold = { type: 'motion', heat: s.occupied.heat, cool: s.occupied.cool, until, by: 'Motion rule' };
    log(t.businessId, `Motion detected at ${labelOf(t)}: comfort hold for ${rule.holdMinutes} min`, t.id, 'Motion rule');
  }

  function applyRecovery(t, now) {
    const s = scheduleOf(t);
    if (t.recovering && (now >= t.recovering || isScheduledOccupied(s, new Date(now)) || !s.recovery.enabled)) t.recovering = null;
    if (t.recovering) return;
    const plan = recoveryPlan(t, now);
    if (!plan || now < plan.start) return;
    t.recovering = plan.ready;
    log(t.businessId, `Started ${labelOf(t)} early to reach ${s.occupied.heat}°–${s.occupied.cool}° by ` +
      new Date(plan.ready).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
      ` (${plan.recoverMin} min recovery + ${plan.staggerMin} min stagger)`, t.id, 'Smart recovery');
  }

  function tick() {
    const now = Date.now();
    const outdoor = 52;
    state.businesses.forEach(biz => { if (biz.hub.online) biz.hub.lastSeen = now; });
    state.thermostats.forEach(t => {
      if (!hubOnline(t)) return;
      if (t.hold && t.hold.until && t.hold.until <= now) t.hold = null;

      const schedOcc = isScheduledOccupied(scheduleOf(t), new Date(now));
      if (t.occupied) { if (Math.random() < 0.12) t.occupied = false; }
      else if (Math.random() < (schedOcc ? 0.2 : 0.015)) t.occupied = true;
      if (t.occupied) t.lastMotion = now;

      applyMotionRule(t, now);
      applyRecovery(t, now);

      const e = effective(t);
      const heatOn = e.heat != null && (t.mode === 'heat' || t.mode === 'auto') && t.temp < e.heat - 0.5;
      const coolOn = e.cool != null && (t.mode === 'cool' || t.mode === 'auto') && t.temp > e.cool + 0.5;
      t.equipment = heatOn ? 'heating' : coolOn ? 'cooling' : 'idle';
      const drift = (outdoor - t.temp) * 0.004;
      t.temp = Math.round((t.temp + drift + (heatOn ? 0.25 : 0) - (coolOn ? 0.25 : 0)) * 10) / 10;
    });
    emit('tick');
  }

  // Loads initial data. Live mode completes Microsoft sign-in first.
  async function start() {
    if (DEMO) {
      setInterval(tick, CONFIG.SIM_TICK_MS);
      return;
    }
    await Auth.handleRedirect();
    await refresh();
    setInterval(() => refresh().then(() => emit('tick')).catch(e => console.warn('Refresh failed', e)), CONFIG.POLL_MS);
  }

  return {
    get state() { return state; },
    subscribe(fn) { listeners.push(fn); },
    start,
    business, building, thermostat, schedule, user, currentUser, buildingOf, businessOf, scheduleOf,
    thermostatsIn, unplacedIn, thermostatsUsing, buildingsUsing, schedulesFor,
    visibleBusinesses, visibleBuildings, canEditSchedule, localAdjustOf,
    isScheduledOccupied, nextScheduleChange, buildingOpenState, effective, activeHold, hubOnline, recoveryPlan,
    actions: DEMO ? demoActions : liveActions,
  };
})();
