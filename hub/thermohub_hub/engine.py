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
        self.mode = 'auto'           # desired mode from the dashboard
        self.hold = None             # manual (from dashboard) or motion (local) hold
        self.hold_seq = None         # last dashboard hold request applied
        self.recovering = None       # ms when recovery target must be reached
        self.rates = {'cool': 4, 'heat': 5}  # °F per hour
        self.last_write = (None, 0)  # (desired, ms)

    def to_saved(self):
        return {'hold': self.hold, 'holdSeq': self.hold_seq, 'recovering': self.recovering, 'mode': self.mode}

    def load_saved(self, d):
        self.hold, self.hold_seq = d.get('hold'), d.get('holdSeq')
        self.recovering, self.mode = d.get('recovering'), d.get('mode', 'auto')

    def report(self):
        return {'entity': self.entity, 'name': self.name, 'model': self.model, 'state': {
            'temp': self.temp, 'humidity': self.humidity, 'occupied': self.occupied, 'lastMotion': self.last_motion,
            'equipment': self.equipment, 'hold': self.hold, 'holdSeq': self.hold_seq,
            'recovering': self.recovering, 'rates': self.rates}}


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
                log.warning('Reading %s failed: %s', dev.entity, e)
                t.reading = None
                continue
            t.reading = r
            t.temp, t.humidity, t.equipment = r['temp'], r['humidity'], r['equipment']
            t.occupied = bool(r['occupied'])
            if t.occupied:
                t.last_motion = now
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
            return  # unassigned: report only, leave the thermostat's own settings alone

        msg = logic.apply_motion_rule(t, sched, now)
        if msg:
            self.event(t, msg, 'Motion rule')
        index, count = self._building_position(cfg)
        msg = logic.apply_recovery(t, sched, now, index, count)
        if msg:
            self.event(t, msg, 'Smart recovery')

        e = logic.effective(t, sched, now)
        desired = (t.mode, e['heat'], e['cool'])
        if self._matches(t.reading, *desired):
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
