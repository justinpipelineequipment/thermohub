# Run: .venv\Scripts\python.exe -m unittest discover -s tests
import unittest
from datetime import datetime

from thermohub_hub import logic
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


class EngineMatchTests(unittest.TestCase):
    def test_matches(self):
        r = {'mode': 'auto', 'heat': 70.2, 'cool': 74.0}
        self.assertTrue(Engine._matches(r, 'auto', 70, 74))
        self.assertFalse(Engine._matches(r, 'auto', 68, 74))
        self.assertFalse(Engine._matches(r, 'heat', 70, 74))
        self.assertTrue(Engine._matches({'mode': 'off', 'heat': 1, 'cool': 2}, 'off', 70, 74))


if __name__ == '__main__':
    unittest.main()
