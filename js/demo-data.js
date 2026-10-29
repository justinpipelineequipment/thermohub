// Demo data shaped like the future backend's data model.
window.DemoData = (function () {
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  function days(weekday, sat, sun) {
    const out = {};
    DAYS.forEach(d => {
      const src = d === 'sat' ? sat : d === 'sun' ? sun : weekday;
      out[d] = src.map(p => ({ ...p }));
    });
    return out;
  }

  function rand(min, max) {
    return Math.round((min + Math.random() * (max - min)) * 10) / 10;
  }

  function create() {
    const businesses = [
      { id: 'biz-1', name: 'Your Business', tenantDomain: 'yourbusiness.com',
        hub: { online: true, lastSeen: Date.now(), version: 'HA 2026.10', paired: true } },
      { id: 'biz-2', name: 'Sample Co (demo tenant)', tenantDomain: 'sampleco.com',
        hub: { online: true, lastSeen: Date.now(), version: 'HA 2026.10', paired: true } },
    ];

    const office = [{ start: '07:00', end: '18:00' }];
    const shop = [{ start: '06:00', end: '16:30' }];
    const sat = [{ start: '08:00', end: '12:00' }];
    const motion = (enabled, holdMinutes) => ({ enabled, holdMinutes, extendOnMotion: true });
    const recovery = () => ({ enabled: true, maxMinutes: 120, staggerMinutes: 20 });

    // Schedule profiles: shared by any number of thermostats in a business.
    const schedules = [
      { id: 'sch-1', businessId: 'biz-1', name: 'Office Hours',
        occupied: { heat: 70, cool: 74 }, unoccupied: { heat: 62, cool: 82 },
        days: days(office, [], []), motionRule: motion(true, 120), recovery: recovery() },
      { id: 'sch-2', businessId: 'biz-1', name: 'Shop Hours',
        occupied: { heat: 66, cool: 76 }, unoccupied: { heat: 58, cool: 85 },
        days: days(shop, sat, []), motionRule: motion(true, 60), recovery: recovery() },
      { id: 'sch-3', businessId: 'biz-1', name: 'Storage / Low Use',
        occupied: { heat: 64, cool: 78 }, unoccupied: { heat: 55, cool: 88 },
        days: days([], [], []), motionRule: motion(true, 30), recovery: recovery() },
      { id: 'sch-4', businessId: 'biz-2', name: 'Office Hours',
        occupied: { heat: 70, cool: 74 }, unoccupied: { heat: 62, cool: 82 },
        days: days(office, [], []), motionRule: motion(true, 120), recovery: recovery() },
    ];

    // [building name, [[thermostat name, schedule id], ...]]
    const b1 = [
      ['Main Office', [['Lobby', 'sch-1'], ['Front Office', 'sch-1'], ['Conference', 'sch-1'], ['Break Room', 'sch-1']]],
      ['North Office', [['Lobby', 'sch-1'], ['Upstairs', 'sch-1'], ['Back Office', 'sch-1']]],
      ['Warehouse A', [['Office', 'sch-1'], ['Warehouse Floor', 'sch-2']]],
      ['Warehouse B', [['Office', 'sch-1'], ['Warehouse Floor', 'sch-2']]],
      ['Shop', [['Shop Floor', 'sch-2'], ['Parts Room', 'sch-3'], ['Office', 'sch-1']]],
      ['Service Center', [['Service Bay', 'sch-2'], ['Front Desk', 'sch-1']]],
      ['Training Center', [['Classroom 1', 'sch-1'], ['Classroom 2', 'sch-1'], ['Lobby', 'sch-1']]],
      ['Sales Office', [['Showroom', 'sch-1'], ['Back Office', 'sch-1']]],
      ['Distribution', [['Dock', 'sch-2'], ['Storage', 'sch-3']]],
      ['Yard Office', [['Main', 'sch-2']]],
    ];
    const b2 = [
      ['Headquarters', [['Lobby', 'sch-4'], ['Offices', 'sch-4']]],
      ['Branch', [['Front', 'sch-4'], ['Back', 'sch-4']]],
    ];

    const buildings = [];
    const thermostats = [];
    let bn = 0, tn = 0;
    function add(bizId, list) {
      list.forEach(([name, stats]) => {
        const id = 'bld-' + (++bn);
        buildings.push({ id, businessId: bizId, name });
        stats.forEach(([tName, scheduleId]) => {
          thermostats.push({
            id: 't-' + (++tn), businessId: bizId, buildingId: id, name: tName, scheduleId,
            model: 'ecobee Smart Thermostat Enhanced',
            mode: 'auto', temp: rand(66, 73), humidity: Math.round(rand(35, 50)),
            occupied: false, lastMotion: null, hold: null, equipment: 'idle',
            // Learned recovery speed in °F per hour (the live hub will measure these).
            rates: { cool: rand(3, 6), heat: rand(4, 7) },
            recovering: null,   // timestamp the profile opens, while smart recovery is running
          });
        });
      });
    }
    add('biz-1', b1);
    add('biz-2', b2);
    // A thermostat the hub just discovered, waiting to be placed in a building.
    thermostats.push({
      id: 't-' + (++tn), businessId: 'biz-1', buildingId: null, scheduleId: null, name: 'ecobee 3F2A',
      model: 'ecobee Smart Thermostat Enhanced', mode: 'auto', temp: 69, humidity: 41,
      occupied: false, lastMotion: null, hold: null, equipment: 'idle', rates: { cool: 4, heat: 5 }, recovering: null,
    });

    const users = [
      { id: 'u-0', businessId: null, name: 'Platform Admin (you)', email: 'admin@platform', role: 'platform_admin', buildingIds: [] },
      { id: 'u-1', businessId: 'biz-1', name: 'Alex Rivera', email: 'alex@yourbusiness.com', role: 'business_admin', buildingIds: [] },
      { id: 'u-2', businessId: 'biz-1', name: 'Sam Lee', email: 'sam@yourbusiness.com', role: 'building_manager', buildingIds: ['bld-3', 'bld-4'] },
      { id: 'u-3', businessId: 'biz-1', name: 'Jordan Kim', email: 'jordan@yourbusiness.com', role: 'viewer', buildingIds: [] },
      { id: 'u-4', businessId: 'biz-2', name: 'Taylor Brooks', email: 'taylor@sampleco.com', role: 'business_admin', buildingIds: [] },
    ];

    return {
      version: 4,
      currentUserId: 'u-0',
      selectedBusinessId: 'all',
      businesses, buildings, thermostats, schedules, users,
      audit: [],
    };
  }

  return { create, DAYS };
})();
