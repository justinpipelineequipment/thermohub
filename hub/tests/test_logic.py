# Run: .venv\Scripts\python.exe -m unittest discover -s tests
import asyncio
import unittest
from datetime import datetime
from types import SimpleNamespace

from thermohub_hub import logic
from thermohub_hub.devices import SimThermostat, clean_alert
from thermohub_hub.engine import Engine, Thermo

DAYS = {k: [{'start': '07:00', 'end': '18:00'}] if k not in ('sat', 'sun') else [] for k in logic.DAY_KEYS}
SCHED = {'id': 's1', 'name': 'Office', 'occupied': {'heat': 70, 'cool': 74}, 'unoccupied': {'heat': 62, 'cool': 82},
         'days': DAYS, 'motionRule': {'enabled': True, 'holdMinutes': 120, 'extendOnMotion': True},
         'recovery': {'enabled': True, 'maxMinutes': 120, 'staggerMinutes': 20}}


def ms(y, mo, d, h, mi=0):
    return int(datetime(y, mo, d, h, mi).timestamp() * 1000)


MON_9AM = ms(2026, 11, 2, 9)     # Monday 2 Nov 2026
MON_10PM = ms(2026, 11, 2, 22)
TUE_6AM = ms(2026, 11, 3, 6)


def thermo(temp=65.0):
    t = Thermo('climate.x', 'X', 'ecobee')
    t.temp = temp
    return t


class ScheduleTests(unittest.TestCase):
    def test_occupied_hours(self):
        self.assertTrue(logic.is_scheduled_occupied(SCHED, MON_9AM))
        self.assertFalse(logic.is_scheduled_occupied(SCHED, MON_10PM))
        self.assertFalse(logic.is_scheduled_occupied(SCHED, ms(2026, 11, 7, 9)))  # Saturday

    def test_next_change(self):
        self.assertEqual(logic.next_schedule_change(SCHED, MON_9AM), ms(2026, 11, 2, 18))
        self.assertEqual(logic.next_schedule_change(SCHED, MON_10PM), ms(2026, 11, 3, 7))
        self.assertIsNone(logic.next_schedule_change(logic.NO_SCHEDULE, MON_9AM))

    def test_effective_follows_schedule_and_holds(self):
        t = thermo()
        self.assertEqual(logic.effective(t, SCHED, MON_9AM)['source'], 'occupied')
        self.assertEqual(logic.effective(t, SCHED, MON_10PM)['heat'], 62)
        t.hold = {'type': 'manual', 'heat': 66, 'cool': 78, 'until': MON_10PM + 60000}
        self.assertEqual(logic.effective(t, SCHED, MON_10PM)['heat'], 66)
        self.assertEqual(logic.effective(t, SCHED, MON_10PM + 120000)['source'], 'unoccupied')  # expired


class MotionTests(unittest.TestCase):
    def test_motion_after_hours_starts_and_extends_hold(self):
        t = thermo()
        t.occupied = True
        self.assertIn('Motion detected', logic.apply_motion_rule(t, SCHED, MON_10PM))
        self.assertEqual((t.hold['type'], t.hold['heat'], t.hold['until']), ('motion', 70, MON_10PM + 120 * 60000))
        self.assertIsNone(logic.apply_motion_rule(t, SCHED, MON_10PM + 600000))
        self.assertEqual(t.hold['until'], MON_10PM + 600000 + 120 * 60000)

    def test_motion_ignored_during_hours_and_never_overrides_manual(self):
        t = thermo()
        t.occupied = True
        self.assertIsNone(logic.apply_motion_rule(t, SCHED, MON_9AM))
        self.assertIsNone(t.hold)
        t.hold = {'type': 'manual', 'heat': 60, 'cool': 85, 'until': None}
        self.assertIsNone(logic.apply_motion_rule(t, SCHED, MON_10PM))
        self.assertEqual(t.hold['type'], 'manual')


class RecoveryTests(unittest.TestCase):
    def test_recovery_starts_early_with_stagger(self):
        t = thermo(65.0)  # 5° below occupied heat at 5°/h -> 60 min
        plan = logic.recovery_plan(t, SCHED, TUE_6AM - 3600000, 2, 3)  # last of 3 -> 20 min stagger
        self.assertEqual((plan['recoverMin'], plan['staggerMin']), (60, 20))
        self.assertEqual(plan['start'], ms(2026, 11, 3, 7) - 80 * 60000)
        self.assertIsNone(logic.apply_recovery(t, SCHED, plan['start'] - 60000, 2, 3))
        self.assertIn('Started X early', logic.apply_recovery(t, SCHED, plan['start'], 2, 3))
        self.assertEqual(logic.effective(t, SCHED, plan['start'] + 60000)['source'], 'recovery')
        logic.apply_recovery(t, SCHED, ms(2026, 11, 3, 7), 2, 3)
        self.assertIsNone(t.recovering)


class LocalChangeTests(unittest.TestCase):
    def test_change_is_held_within_limits(self):
        t = thermo()
        msg = logic.apply_local_change(t, SCHED, MON_9AM, 72.4, 74)
        self.assertEqual((t.hold['type'], t.hold['heat'], t.hold['cool']), ('local', 72, 74))
        self.assertEqual(t.hold['until'], MON_9AM + 60 * 60000)  # default 60 min
        self.assertNotIn('requested', msg)
        msg = logic.apply_local_change(t, SCHED, MON_9AM, 80, 85)  # limits stay relative to schedule 70/74
        self.assertEqual((t.hold['heat'], t.hold['cool']), (73, 77))
        self.assertIn('limit is 3°', msg)

    def test_disabled_or_dashboard_hold_undoes_change(self):
        t = thermo()
        off = {**SCHED, 'localAdjust': {'enabled': False, 'minutes': 60, 'maxDegrees': 3}}
        self.assertIn('undone', logic.apply_local_change(t, off, MON_9AM, 73, 74))
        self.assertIsNone(t.hold)
        t.hold = {'type': 'manual', 'heat': 66, 'cool': 78, 'until': None}
        self.assertIn('undone', logic.apply_local_change(t, SCHED, MON_9AM, 73, 78))
        self.assertEqual(t.hold['type'], 'manual')

    def test_motion_does_not_replace_local_change(self):
        t = thermo()
        logic.apply_local_change(t, SCHED, MON_10PM, 64, 82)
        t.occupied = True
        self.assertIsNone(logic.apply_motion_rule(t, SCHED, MON_10PM + 60000))
        self.assertEqual(t.hold['type'], 'local')


class LocalChangeEngineTests(unittest.TestCase):
    """Hub loop with a simulated thermostat, during occupied hours (70°–74°)."""

    def setUp(self, sched=SCHED):
        self.eng = Engine.__new__(Engine)
        self.cfg = {'id': 't1', 'entity': 'climate.sim_thermostat_1', 'buildingId': None, 'scheduleId': 's1',
                    'mode': 'auto', 'hold': None, 'holdSeq': 0}
        self.eng.cache = SimpleNamespace(data={'schedules': [sched], 'thermostats': [self.cfg]})
        self.eng.events = []
        self.dev = SimThermostat(1)
        self.t = Thermo(self.dev.entity, 'X', 'ecobee')
        self.now = MON_9AM
        self.step()
        self.step()  # hub has set 70/74 and seen it

    def step(self, minutes=0.25):
        self.now += int(minutes * 60000)
        r = asyncio.run(self.dev.read())
        self.t.prev_reading, self.t.reading = self.t.reading, r
        asyncio.run(self.eng._control(self.dev, self.t, self.now))

    def test_change_at_screen_lasts_60_min(self):
        self.assertEqual((self.dev.heat, self.dev.cool), (70, 74))
        self.dev.heat = 78  # someone at the screen
        self.step()
        self.assertEqual((self.t.hold['type'], self.dev.heat), ('local', 73))  # pulled back to the 3° limit
        self.assertIn('changed at the thermostat', self.eng.events[-1]['text'])
        self.step(30)
        self.assertEqual(self.dev.heat, 73)
        self.step(31)
        self.assertEqual(self.dev.heat, 70)  # back on schedule

    def test_disabled_puts_it_back_right_away(self):
        self.setUp({**SCHED, 'localAdjust': {'enabled': False, 'minutes': 60, 'maxDegrees': 3}})
        self.dev.heat = 72
        self.step()
        self.assertEqual((self.t.hold, self.dev.heat), (None, 70))

    def test_mode_changes_put_back_but_dashboard_changes_are_not_local(self):
        self.dev.mode = 'off'
        self.step()
        self.assertEqual(self.dev.mode, 'auto')
        self.assertIn('Mode changed', self.eng.events[-1]['text'])
        self.step()
        self.cfg['mode'] = 'heat'  # from the dashboard
        self.step()
        self.step()
        self.assertEqual((self.dev.mode, self.t.hold), ('heat', None))


class AlertTests(unittest.TestCase):
    def test_alert_logged_when_it_appears_and_clears(self):
        eng = Engine.__new__(Engine)
        eng.events = []
        dev, t = SimThermostat(1), Thermo('climate.sim_thermostat_1', 'X', 'ecobee')
        check = lambda now: asyncio.run(eng._check_alert(dev, t, now))  # noqa: E731
        check(MON_9AM)
        self.assertEqual((t.alert, eng.events), (None, []))
        dev.alert = 'There may be a problem with the Cooling system.'
        check(MON_10PM)
        self.assertEqual((t.alert, t.alert_since, t.alert_checked), (dev.alert, MON_10PM, MON_10PM))
        self.assertIn('Alert on X: There may be', eng.events[-1]['text'])
        check(TUE_6AM)
        self.assertEqual(len(eng.events), 1)  # unchanged: no repeat
        dev.alert = None
        check(TUE_6AM + 3600000)
        self.assertEqual((t.alert, t.alert_since), (None, None))
        self.assertIn('Alert cleared', eng.events[-1]['text'])


class CleanAlertTests(unittest.TestCase):
    def test_no_alert_message_and_truncation(self):
        self.assertIsNone(clean_alert('The Hive is humming along. You have no pending alerts or reminders.'))
        self.assertIsNone(clean_alert('  '))
        self.assertEqual(clean_alert('There may be a problem with  the Cooling'), 'There may be a problem with the Cooling…')
        self.assertEqual(clean_alert('Filter reminder.'), 'Filter reminder.')


class SavedStateTests(unittest.TestCase):
    def test_last_motion_survives_restart(self):
        t = thermo()
        t.last_motion = MON_9AM
        t2 = thermo()
        t2.load_saved(t.to_saved())
        self.assertEqual(t2.last_motion, MON_9AM)


class OfflineTests(unittest.TestCase):
    def test_not_responding_after_two_missed_polls(self):
        eng = Engine.__new__(Engine)
        eng.events = []
        t = Thermo('climate.x', 'X', 'ecobee')
        eng._missed_poll(t, MON_9AM, TimeoutError('timed out'))
        self.assertEqual((t.offline_since, eng.events), (None, []))  # one miss is not enough
        eng._missed_poll(t, MON_9AM + 15000, TimeoutError('timed out'))
        self.assertEqual(t.offline_since, MON_9AM + 15000)
        self.assertIn('X is not responding (timed out)', eng.events[-1]['text'])
        eng._missed_poll(t, MON_9AM + 30000, TimeoutError('timed out'))
        self.assertEqual(len(eng.events), 1)  # logged once
        self.assertEqual(t.report()['state']['offlineSince'], MON_9AM + 15000)


class EngineMatchTests(unittest.TestCase):
    def test_matches(self):
        r = {'mode': 'auto', 'heat': 70.2, 'cool': 74.0}
        self.assertTrue(Engine._matches(r, 'auto', 70, 74))
        self.assertFalse(Engine._matches(r, 'auto', 68, 74))
        self.assertFalse(Engine._matches(r, 'heat', 70, 74))
        self.assertTrue(Engine._matches({'mode': 'off', 'heat': 1, 'cool': 2}, 'off', 70, 74))


if __name__ == '__main__':
    unittest.main()
