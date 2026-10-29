# Thermostat access. HomeKitDevices talks to real ecobees on the local network (HomeKit over IP);
# SimDevices fakes thermostats for testing without hardware.
import asyncio
import logging
import random
import re

log = logging.getLogger('thermohub')

MODES = ['off', 'heat', 'cool', 'auto']  # HomeKit TargetHeatingCoolingState 0..3
EQUIPMENT = {0: 'idle', 1: 'heating', 2: 'cooling'}  # CurrentHeatingCoolingState


def c_to_f(c):
    return None if c is None else round(c * 9 / 5 + 32, 1)


def f_to_c(f):
    return round((f - 32) * 5 / 9, 1)


def entity_for(name, taken):
    """Dashboard entity id (climate.<slug>), unique on this hub."""
    base = 'climate.' + (re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_') or 'thermostat')
    entity, n = base, 2
    while entity in taken:
        entity, n = f'{base}_{n}', n + 1
    return entity


# ---------------------------------------------------------------- HomeKit
class HomeKitThermostat:
    def __init__(self, alias, entity, name, pairing):
        self.alias, self.entity, self.name, self.model = alias, entity, name, 'ecobee'
        self.pairing = pairing
        self.chars = None  # {key: (aid, iid, min, max)}

    async def _map(self):
        from aiohomekit.model import Accessories
        from aiohomekit.model.characteristics import CharacteristicsTypes as C
        from aiohomekit.model.services import ServicesTypes as S

        accs = Accessories.from_list(await self.pairing.list_accessories_and_characteristics())
        acc = next((a for a in accs if a.services.first(service_type=S.THERMOSTAT)), None)
        if not acc:
            raise RuntimeError(f'{self.name} has no thermostat service')
        info = acc.services.first(service_type=S.ACCESSORY_INFORMATION)
        if info:
            self.model = ' '.join(filter(None, [info.value(C.MANUFACTURER), info.value(C.MODEL)]))[:100] or 'ecobee'
        thermo = acc.services.first(service_type=S.THERMOSTAT)
        wanted = {
            'temp': C.TEMPERATURE_CURRENT, 'target': C.TEMPERATURE_TARGET,
            'heat': C.TEMPERATURE_HEATING_THRESHOLD, 'cool': C.TEMPERATURE_COOLING_THRESHOLD,
            'mode': C.HEATING_COOLING_TARGET, 'state': C.HEATING_COOLING_CURRENT,
            'humidity': C.RELATIVE_HUMIDITY_CURRENT,
        }
        chars = {k: thermo[t] for k, t in wanted.items() if thermo.has(t)}
        # ecobee reports its built-in motion sensor as an occupancy sensor on the same accessory
        occ = acc.services.first(service_type=S.OCCUPANCY_SENSOR)
        if occ and occ.has(C.OCCUPANCY_DETECTED):
            chars['occupied'] = occ[C.OCCUPANCY_DETECTED]
        self.chars = {k: (acc.aid, c.iid, c.minValue, c.maxValue) for k, c in chars.items()}

    async def read(self):
        if self.chars is None:
            await self._map()
        res = await self.pairing.get_characteristics([(a, i) for a, i, *_ in self.chars.values()])
        v = {k: res.get((a, i), {}).get('value') for k, (a, i, *_) in self.chars.items()}
        mode = MODES[v['mode']] if isinstance(v.get('mode'), int) and 0 <= v['mode'] < 4 else 'auto'
        heat, cool = c_to_f(v.get('heat')), c_to_f(v.get('cool'))
        if mode in ('heat', 'cool') and v.get('target') is not None:  # single setpoint modes use TargetTemperature
            heat, cool = (c_to_f(v['target']), cool) if mode == 'heat' else (heat, c_to_f(v['target']))
        return {'temp': c_to_f(v.get('temp')), 'humidity': v.get('humidity'), 'occupied': bool(v.get('occupied')),
                'equipment': EQUIPMENT.get(v.get('state'), 'idle'), 'mode': mode, 'heat': heat, 'cool': cool}

    def _put(self, out, key, f):
        if key not in self.chars or f is None:
            return
        aid, iid, lo, hi = self.chars[key]
        c = f_to_c(f)
        c = max(lo, c) if lo is not None else c
        c = min(hi, c) if hi is not None else c
        out.append((aid, iid, c))

    async def write(self, mode, heat, cool):
        if self.chars is None:
            await self._map()
        out = [(*self.chars['mode'][:2], MODES.index(mode))]
        if mode == 'heat':
            self._put(out, 'target', heat)
        elif mode == 'cool':
            self._put(out, 'target', cool)
        elif mode == 'auto':
            self._put(out, 'heat', heat)
            self._put(out, 'cool', cool)
        await self.pairing.put_characteristics(out)


class HomeKitDevices:
    """Pairs and controls ecobees over HomeKit. Pairings are stored in settings.json."""

    def __init__(self, settings):
        self.settings = settings
        self.controller = self._zc = self._browser = None
        self.thermostats = {}

    async def start(self):
        from aiohomekit import Controller
        from aiohomekit.zeroconf import HAP_TYPE_TCP, HAP_TYPE_UDP
        from zeroconf.asyncio import AsyncServiceBrowser, AsyncZeroconf

        self._zc = AsyncZeroconf()
        # aiohomekit looks for an existing browser of HomeKit services on the zeroconf instance
        self._browser = AsyncServiceBrowser(self._zc.zeroconf, [HAP_TYPE_TCP, HAP_TYPE_UDP], handlers=[lambda **_: None])
        self.controller = Controller(async_zeroconf_instance=self._zc)
        await self.controller.async_start()
        for alias, p in self.settings.data['pairings'].items():
            self._load(alias, p)

    def _load(self, alias, p):
        pairing = self.controller.load_pairing(alias, dict(p['data']))
        self.thermostats[alias] = HomeKitThermostat(alias, p['entity'], p['name'], pairing)

    async def stop(self):
        if self.controller:
            await self.controller.async_stop()
        if self._browser:
            await self._browser.async_cancel()
        if self._zc:
            await self._zc.async_close()

    def list(self):
        return list(self.thermostats.values())

    async def discover(self):
        """Unpaired HomeKit thermostats visible on the network."""
        from aiohomekit.model.categories import Categories

        found = []
        async for d in self.controller.async_discover():
            desc = d.description
            if not d.paired and desc.category == Categories.THERMOSTAT:
                found.append({'id': desc.id, 'name': desc.name})
        return sorted(found, key=lambda x: x['name'])

    async def pair(self, device_id, code, name):
        code = re.sub(r'\D', '', code)
        if len(code) != 8:
            raise ValueError('Enter the 8-digit HomeKit code shown on the thermostat.')
        code = f'{code[:3]}-{code[3:5]}-{code[5:]}'
        name = (name or '').strip() or device_id
        alias = device_id.lower()
        discovery = await self.controller.async_find(device_id)
        finish = await discovery.async_start_pairing(alias)
        pairing = await finish(code)
        entity = entity_for(name, {t.entity for t in self.thermostats.values()})
        self.settings.data['pairings'][alias] = {'entity': entity, 'name': name, 'data': dict(pairing.pairing_data)}
        self.settings.save()
        self.thermostats[alias] = HomeKitThermostat(alias, entity, name, pairing)
        return entity

    async def unpair(self, alias):
        if alias in self.thermostats:
            try:
                await self.controller.remove_pairing(alias)
            except Exception as e:  # noqa: BLE001 - forget it locally even if the thermostat is unreachable
                log.warning('Removing pairing %s on the thermostat failed: %s', alias, e)
            del self.thermostats[alias]
        self.settings.data['pairings'].pop(alias, None)
        self.settings.save()


# ---------------------------------------------------------------- simulation
class SimThermostat:
    def __init__(self, i):
        self.alias = f'sim{i}'
        self.name = f'Sim Thermostat {i}'
        self.entity = f'climate.sim_thermostat_{i}'
        self.model = 'Simulated ecobee'
        self.temp = round(random.uniform(60, 78), 1)
        self.mode, self.heat, self.cool = 'auto', 68.0, 75.0
        self.occupied = False
        self.equipment = 'idle'

    async def read(self):
        await asyncio.sleep(0)
        self.occupied = random.random() < 0.15
        heat_on = self.mode in ('heat', 'auto') and self.temp < self.heat - 0.5
        cool_on = self.mode in ('cool', 'auto') and self.temp > self.cool + 0.5
        self.equipment = 'heating' if heat_on else 'cooling' if cool_on else 'idle'
        self.temp = round(self.temp + (0.3 if heat_on else 0) - (0.3 if cool_on else 0) + (55 - self.temp) * 0.003, 1)
        return {'temp': self.temp, 'humidity': 40, 'occupied': self.occupied, 'equipment': self.equipment,
                'mode': self.mode, 'heat': self.heat, 'cool': self.cool}

    async def write(self, mode, heat, cool):
        self.mode = mode
        self.heat = heat if heat is not None else self.heat
        self.cool = cool if cool is not None else self.cool


class SimDevices:
    def __init__(self, count):
        self.thermostats = {t.alias: t for t in (SimThermostat(i + 1) for i in range(count))}

    async def start(self):
        pass

    async def stop(self):
        pass

    def list(self):
        return list(self.thermostats.values())

    async def discover(self):
        return [{'id': 'AA:BB:CC:DD:EE:01', 'name': 'ecobee Thermostat (simulated)'}]

    async def pair(self, device_id, code, name):
        raise ValueError('Pairing is not available in simulation mode.')

    async def unpair(self, alias):
        self.thermostats.pop(alias, None)
