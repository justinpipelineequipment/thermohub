# Schedule, motion and smart-recovery rules. Mirrors js/store.js so the hub and dashboard agree.
# Times are epoch milliseconds (like the dashboard); schedule hours are local wall-clock time.
import math
from datetime import datetime, timedelta

DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']  # datetime.weekday() order

# Stand-in for thermostats not yet assigned a profile: no hours, no automation, hub leaves it alone.
NO_SCHEDULE = {
    'id': None, 'name': 'No schedule',
    'occupied': {'heat': None, 'cool': None}, 'unoccupied': {'heat': None, 'cool': None},
    'days': {k: [] for k in DAY_KEYS},
    'motionRule': {'enabled': False, 'holdMinutes': 120, 'extendOnMotion': True},
    'recovery': {'enabled': False, 'maxMinutes': 120, 'staggerMinutes': 0},
}


def to_min(hhmm):
    h, m = hhmm.split(':')
    return int(h) * 60 + int(m)


def _dt(ms):
    return datetime.fromtimestamp(ms / 1000)


def _ms(dt):
    return int(dt.timestamp() * 1000)


def is_scheduled_occupied(sched, now_ms):
    d = _dt(now_ms)
    periods = sched['days'].get(DAY_KEYS[d.weekday()]) or []
    now = d.hour * 60 + d.minute
    return any(to_min(p['start']) <= now < to_min(p['end']) for p in periods)


def next_schedule_change(sched, from_ms):
    """Next time the schedule switches between occupied/unoccupied (searches 7 days in 15-min steps)."""
    start = is_scheduled_occupied(sched, from_ms)
    d = _dt(from_ms).replace(second=0, microsecond=0)
    for _ in range(7 * 24 * 4):
        d += timedelta(minutes=15 - d.minute % 15)
        if is_scheduled_occupied(sched, _ms(d)) != start:
            return _ms(d)
    return None


def active_hold(t, now_ms):
    h = t.hold
    if not h or (h.get('until') and h['until'] <= now_ms):
        return None
    return h


def stagger_offset(index, count, stagger_minutes):
    """First thermostat in a building starts on time, the last up to stagger_minutes earlier."""
    return round(index / (count - 1) * stagger_minutes) if count > 1 else 0


def recovery_plan(t, sched, now_ms, index, count):
    """When smart recovery should start so the thermostat reaches the occupied target by opening."""
    r = sched.get('recovery')
    if not r or not r.get('enabled') or t.mode == 'off' or t.temp is None or is_scheduled_occupied(sched, now_ms):
        return None
    ready = next_schedule_change(sched, now_ms)
    if not ready:
        return None
    p = sched['occupied']
    deg, rate = 0, 1
    if t.temp > p['cool'] and t.mode != 'heat':
        deg, rate = t.temp - p['cool'], t.rates['cool']
    elif t.temp < p['heat'] and t.mode != 'cool':
        deg, rate = p['heat'] - t.temp, t.rates['heat']
    recover_min = min(r['maxMinutes'], math.ceil(deg / rate * 60))
    stagger_min = stagger_offset(index, count, r.get('staggerMinutes', 0))
    return {'ready': ready, 'recoverMin': recover_min, 'staggerMin': stagger_min,
            'start': ready - (recover_min + stagger_min) * 60000}


def effective(t, sched, now_ms):
    """What the thermostat should target right now, and why."""
    hold = active_hold(t, now_ms)
    if hold:
        return {'heat': hold.get('heat'), 'cool': hold.get('cool'), 'source': hold['type']}
    occ = is_scheduled_occupied(sched, now_ms)
    if not occ and t.recovering and now_ms < t.recovering:
        return {'heat': sched['occupied']['heat'], 'cool': sched['occupied']['cool'], 'source': 'recovery'}
    p = sched['occupied'] if occ else sched['unoccupied']
    return {'heat': p['heat'], 'cool': p['cool'], 'source': 'occupied' if occ else 'unoccupied'}


def apply_motion_rule(t, sched, now_ms):
    """Motion outside occupied hours -> hold the occupied comfort setting. Never overrides a manual hold.
    Returns an audit message when a new motion hold starts."""
    rule = sched['motionRule']
    if not rule.get('enabled') or not t.occupied or is_scheduled_occupied(sched, now_ms):
        return None
    hold = active_hold(t, now_ms)
    if hold and hold['type'] == 'manual':
        return None
    until = now_ms + rule['holdMinutes'] * 60000
    if hold and hold['type'] == 'motion':
        if rule.get('extendOnMotion'):
            hold['until'] = until
        return None
    t.hold = {'type': 'motion', 'heat': sched['occupied']['heat'], 'cool': sched['occupied']['cool'],
              'until': until, 'by': 'Motion rule'}
    return f"Motion detected at {t.name}: comfort hold for {rule['holdMinutes']} min"


def apply_recovery(t, sched, now_ms, index, count):
    """Starts smart recovery when it's time. Returns an audit message when recovery starts."""
    if t.recovering and (now_ms >= t.recovering or is_scheduled_occupied(sched, now_ms)
                         or not sched['recovery'].get('enabled')):
        t.recovering = None
    if t.recovering:
        return None
    plan = recovery_plan(t, sched, now_ms, index, count)
    if not plan or now_ms < plan['start']:
        return None
    t.recovering = plan['ready']
    p = sched['occupied']
    ready = _dt(plan['ready']).strftime('%I:%M %p').lstrip('0')
    return (f"Started {t.name} early to reach {p['heat']}°–{p['cool']}° by {ready} "
            f"({plan['recoverMin']} min recovery + {plan['staggerMin']} min stagger)")
