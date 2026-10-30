// Small rendering helpers shared by the views.
window.UI = (function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);

  function temp(n) { return n == null ? '—' : Math.round(n) + '°'; }

  function timeAgo(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' hr ago';
    return new Date(ts).toLocaleDateString();
  }

  // '4:30 PM' today, otherwise 'Tue 7:00 AM'
  function when(ts) {
    const d = new Date(ts);
    const sameDay = d.toDateString() === new Date().toDateString();
    return (sameDay ? '' : d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ') +
      d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function until(ts) { return ts ? 'until ' + when(ts) : 'indefinitely'; }

  function badge(text, kind) { return `<span class="badge badge-${kind}">${esc(text)}</span>`; }

  function holdBadge(e) {
    if (e.source === 'recovery') return badge('Smart recovery: ready by ' + when(e.readyAt), 'recovery');
    if (!e.hold) return e.source === 'occupied' ? badge('Schedule: occupied', 'ok') : badge('Schedule: after hours', 'muted');
    if (e.hold.type === 'motion') return badge('Motion override ' + until(e.hold.until), 'motion');
    if (e.hold.type === 'local') return badge('Changed at thermostat ' + until(e.hold.until), 'hold');
    return badge('Manual hold ' + until(e.hold.until), 'hold');
  }

  function equipBadge(t) {
    if (t.equipment === 'heating') return badge('Heating', 'heat');
    if (t.equipment === 'cooling') return badge('Cooling', 'cool');
    return badge('Idle', 'muted');
  }

  function motionDot(t) {
    return t.occupied
      ? `<span class="motion on" title="Motion detected now"></span>Motion`
      : `<span class="motion" title="No motion"></span>${esc(t.lastMotion ? timeAgo(t.lastMotion) : 'No motion')}`;
  }

  // '07:00' -> '7 AM', '16:30' -> '4:30 PM'
  function clock(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const h12 = h % 12 || 12;
    return h12 + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? ' AM' : ' PM');
  }

  // Groups consecutive days with identical hours: "Mon–Fri 7 AM–6 PM · Sat 8 AM–12 PM"
  function hoursSummary(days) {
    const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const label = d => d[0].toUpperCase() + d.slice(1);
    const key = d => days[d].map(p => clock(p.start) + '–' + clock(p.end)).join(', ');
    const groups = [];
    order.forEach(d => {
      const k = key(d), last = groups[groups.length - 1];
      if (last && last.k === k) last.end = d; else groups.push({ k, start: d, end: d });
    });
    const open = groups.filter(g => g.k);
    if (!open.length) return 'No occupied hours (after-hours settings all week)';
    return open.map(g => (g.start === g.end ? label(g.start) : label(g.start) + '–' + label(g.end)) + ' ' + g.k).join(' · ');
  }

  let toastTimer;
  function toast(msg, isError) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3500);
  }

  return { esc, temp, timeAgo, when, until, badge, holdBadge, equipBadge, motionDot, clock, hoursSummary, toast };
})();
