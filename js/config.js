// App-wide settings. Change APP_NAME to rename the site.
window.CONFIG = {
  APP_NAME: 'ThermoHub',
  DEMO_MODE: true,          // true = simulated thermostats, no backend or sign-in
  SIM_TICK_MS: 4000,        // demo simulation update interval
  TEMP_UNIT: 'F',

  // Live mode (DEMO_MODE: false)
  API_URL: 'https://thermohub-api.YOUR-SUBDOMAIN.workers.dev',
  ENTRA_CLIENT_ID: 'REPLACE_WITH_CLIENT_ID',   // Entra app registration (multi-tenant)
  POLL_MS: 15000,           // how often the dashboard refreshes live data
};
