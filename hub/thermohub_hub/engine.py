# The hub's main loop: read thermostats, apply schedules / holds / motion / recovery, sync with the cloud.
# Keeps running on the last known config when the internet is down.
import asyncio
import logging
import time

from . import logic
from .cloud import Cloud, CloudError
from .settings import JsonFile

log = logging.getLogger('thermohub')

TICK_SECONDS = 15
WRITE_RETRY_MS = 5 * 60000   # re-send unchanged setpoints at most this often (thermostat may adjust them)
TOLERANCE = 0.6              # °F difference that counts as "already set"
ALERT_CHECK_MS = 30 * 60000  # read the thermostat's own alert text this often (and at startup)
OFFLINE_AFTER = 2            # missed polls in a row before a thermostat counts as not responding


def now_ms():
    return int(time.time() * 1000)


class Thermo:
    """Hub-side state of one thermostat."""

    def __init__(self, entity, name, model):
        self.entity, self.name, self.model = entity, name, model
        self.temp = self.humidity = self.last_motion = None
        self.occupied = False
        self.equipment = 'idle'
        self.reading = None          # last device reading
        self.prev_reading = None     # the reading before that
        self.in_sync = False         # last reading matched what the hub wanted
        self.mode = 'auto'           # desired mode from the dashboard
        self.hold = None             # manual (from dashboard), motion or local (changed at the thermostat) hold
        self.hold_seq = None         # last dashboard hold request applied
        self.recovering = None       # ms when recovery target must be reached
        self.rates = {'cool': 4, 'heat': 5}  # °F per hour
        self.last_write = (None, 0)  # (desired, ms)
        self.alert = None            # thermostat's own alert text
        self.alert_since = None      # ms the alert was first seen
        self.alert_checked = 0       # ms of last alert read
        self.missed = 0              # polls in a row the thermostat didn't answer
        self.offline_since = None    # ms it stopped answering (after OFFLINE_AFTER misses)

    def to_saved(self):
        return {'hold': self.hold, 'holdSeq': self.hold_seq, 'recovering': self.recovering, 'mode': self.mode,
                'alert': self.alert, 'alertSince': self.alert_since}

    def load_saved(self, d):
        self.hold, self.hold_seq = d.get('hold'), d.get('holdSeq')
        self.recovering, self.mode = d.get('recovering'), d.get('mode', 'auto')
        self.alert, self.alert_since = d.get('alert'), d.get('alertSince')

    def report(self):
        return {'entity': self.entity, 'name': self.name, 'model': self.model, 'state': {
            'temp': self.temp, 'humidity': self.humidity, 'occupied': self.occupied, 'lastMotion': self.last_motion,
            'equipment': self.equipment, 'hold': self.hold, 'holdSeq': self.hold_seq,
            'recovering': self.recovering, 'rates': self.rates, 'alert': self.alert, 'alertSince': self.alert_since,
            'offlineSince': self.offline_since}}


class Engine:
    def __init__(self, settings, devices):
        self.settings = settings
        self.devices = devices
        self.cloud = Cloud(settings)
        self.cache = JsonFile('cloud-config.json', {'configVersion': None, 'schedules': [], 'thermostats': []})
        self.saved = JsonFile('hub-state.json', {})
        self.thermos = {}
        self.events = []
        self.status = {'cloud': 'Not connected yet', 'cloudOk': False, 'lastSync': None}

    # ---------- config ----------
    def _config_for(self, entity):
        return next((c for c in self.cache.data['thermostats'] if c['entity'] == entity), None)

    def _schedule(self, sched_id):
        return next((s for s in self.cache.data['schedules'] if s['id'] == sched_id), logic.NO_SCHEDULE)

    def _building_position(self, cfg):
        """(index, count) of this thermostat among its building's thermostats, for staggered starts."""
        same = [c['id'] for c in self.cache.data['thermostats'] if cfg and c.get('buildingId') == cfg.get('buildingId')]
        return (same.index(cfg['id']), len(same)) if cfg and cfg.get('buildingId') else (0, 1)

    def event(self, t, text, who='Hub'):
        log.info('%s', text)
        self.events.append({'ts': now_ms(), 'entity': t.entity if t else '', 'who': who, 'text': text})
        del self.events[:-100]

    # ---------- one pass ----------
    async def tick(self):
        now = now_ms()
        for dev in self.devices.list():
            t = self.thermos.get(dev.entity)
            if not t:
                t = self.thermos[dev.entity] = Thermo(dev.entity, dev.name, dev.model)
                t.load_saved(self.saved.data.get(dev.entity, {}))
            try:
                r = await dev.read()
            except Exception as e:  # noqa: BLE001 - one bad thermostat must not stop the others
                self._missed_poll(t, now, e)
                continue
            if t.offline_since:
                self.event(t, f'{t.name} is responding again', 'Hub')
            t.missed, t.offline_since = 0, None
            t.prev_reading, t.reading = t.reading, r
            t.temp, t.humidity, t.equipment = r['temp'], r['humidity'], r['equipment']
            t.occupied = bool(r['occupied'])
            if t.occupied:
                t.last_motion = now
            if now - t.alert_checked >= ALERT_CHECK_MS:
                await self._check_alert(dev, t, now)
            await self._control(dev, t, now)

        self.saved.data = {e: t.to_saved() for e, t in self.thermos.items()}
        self.saved.save()
        await self._sync()

    async def _control(self, dev, t, now):
        cfg = self._config_for(t.entity)
        if cfg:
            t.mode = cfg.get('mode') or 'auto'
            if cfg.get('holdSeq') != t.hold_seq:      # new hold / resume request from the dashboard
                t.hold, t.hold_seq = cfg.get('hold'), cfg.get('holdSeq')
        sched = self._schedule(cfg.get('scheduleId')) if cfg else logic.NO_SCHEDULE
        if t.hold and t.hold.get('until') and t.hold['until'] <= now:
            t.hold = None
        if sched is logic.NO_SCHEDULE and not logic.active_hold(t, now):
            t.in_sync = False
            return  # unassigned: report only, leave the thermostat's own settings alone

        self._check_local_change(t, sched, now)
        msg = logic.apply_motion_rule(t, sched, now)
        if msg:
            self.event(t, msg, 'Motion rule')
        index, count = self._building_position(cfg)
        msg = logic.apply_recovery(t, sched, now, index, count)
        if msg:
            self.event(t, msg, 'Smart recovery')

        e = logic.effective(t, sched, now)
        desired = (t.mode, e['heat'], e['cool'])
        t.in_sync = self._matches(t.reading, *desired)
        if t.in_sync:
            return
        last_desired, last_ms = t.last_write
        if desired == last_desired and now - last_ms < WRITE_RETRY_MS:
            return
        t.last_write = (desired, now)
        try:
            await dev.write(*desired)
            log.info('Set %s: mode %s, heat %s, cool %s (%s)', t.entity, *desired, e['source'])
        except Exception as ex:  # noqa: BLE001
            log.warning('Writing %s failed: %s', t.entity, ex)

    def _missed_poll(self, t, now, error):
        t.missed += 1
        t.reading = None
        if t.missed == 1:
            log.warning('Reading %s failed: %s', t.entity, error)
        if t.missed == OFFLINE_AFTER:
            t.offline_since = now
            self.event(t, f'{t.name} is not responding ({error or type(error).__name__})', 'Hub')

    async def _check_alert(self, dev, t, now):
        """Read the thermostat's own alert; log when one appears or clears."""
        t.alert_checked = now
        try:
            alert = await dev.read_alert()
        except Exception as e:  # noqa: BLE001 - try again next hour
            log.warning('Reading alert on %s failed: %s', t.entity, e)
            return
        if alert == t.alert:
            return
        if alert:
            t.alert_since = now
            self.event(t, f'Alert on {t.name}: {alert}', 'Thermostat')
        else:
            t.alert_since = None
            self.event(t, f'Alert cleared on {t.name}', 'Thermostat')
        t.alert = alert

    def _check_local_change(self, t, sched, now):
        """Someone changed the thermostat at its screen: the reading moved away from a setting the hub had
        confirmed, to something the hub didn't ask for. Setpoint changes may become a temporary local hold
        (see logic.apply_local_change); mode changes are always put back."""
        prev, r = t.prev_reading, t.reading
        if not (t.in_sync and prev and r):
            return
        if r['mode'] != prev['mode']:
            if r['mode'] != t.mode:
                t.last_write = (None, 0)  # put it back on this pass
                self.event(t, f"Mode changed at {t.name} to {r['mode']}: set back to {t.mode} "
                              '(mode is set from the dashboard)', 'At thermostat')
            return
        if r['mode'] != t.mode:
            return  # mode just changed from the dashboard; the hub hasn't sent it yet
        e = logic.effective(t, sched, now)
        if (t.mode == 'off' or self._matches(r, t.mode, prev['heat'], prev['cool'])
                or self._matches(r, t.mode, e['heat'], e['cool'])):
            return
        self.event(t, logic.apply_local_change(t, sched, now, r['heat'], r['cool']), 'At thermostat')
        t.last_write = (None, 0)

    @staticmethod
    def _matches(r, mode, heat, cool):
        if r is None or r['mode'] != mode:
            return False
        close = lambda a, b: b is None or (a is not None and abs(a - b) <= TOLERANCE)  # noqa: E731
        if mode == 'heat':
            return close(r['heat'], heat)
        if mode == 'cool':
            return close(r['cool'], cool)
        return mode == 'off' or (close(r['heat'], heat) and close(r['cool'], cool))

    async def _sync(self):
        try:
            events = list(self.events)
            version = await self.cloud.report([t.report() for t in self.thermos.values()], events)
            del self.events[:len(events)]
            if version != self.cache.data.get('configVersion'):
                self.cache.data = await self.cloud.config()
                self.cache.save()
                log.info('Loaded config version %s', self.cache.data.get('configVersion'))
            self.status = {'cloud': 'Connected', 'cloudOk': True, 'lastSync': now_ms()}
        except CloudError as e:
            self.status = {**self.status, 'cloud': str(e), 'cloudOk': False}
            log.warning('%s', e)

    async def run(self, stop: asyncio.Event):
        while not stop.is_set():
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 - keep the hub alive
                log.exception('Hub loop error')
            try:
                await asyncio.wait_for(stop.wait(), TICK_SECONDS)
            except asyncio.TimeoutError:
                pass
        await self.cloud.close()
