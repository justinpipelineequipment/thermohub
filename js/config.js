// App-wide settings. Change APP_NAME to rename the site.
window.CONFIG = {
  APP_NAME: 'ThermoHub',
  DEMO_MODE: false,         // true = simulated thermostats, no backend or sign-in
  SIM_TICK_MS: 4000,        // demo simulation update interval
  TEMP_UNIT: 'F',

  // Live mode (DEMO_MODE: false)
  API_URL: 'https://thermohub-api.thermohub-api.workers.dev',
  ENTRA_CLIENT_ID: 'c9e15178-c466-40ad-a771-5caf5fbbef74',   // Entra app registration (multi-tenant)
  POLL_MS: 15000,           // how often the dashboard refreshes live data
};
