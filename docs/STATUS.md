# ThermoHub status

Last updated 2026-10-29. Read this first when picking the project up on another PC.

## Live

| Piece | Where |
|---|---|
| Dashboard | https://thermohub-web.thermohub-api.workers.dev (Cloudflare Worker `thermohub-web`, static files) |
| API | https://thermohub-api.thermohub-api.workers.dev (Worker `thermohub-api`, `backend/`) |
| Database | Cloudflare D1 `thermohub` (`ac11b553-ed30-4db4-b2de-2fe50d270159`) |
| Sign-in | Entra app "ThermoHub", client `c9e15178-c466-40ad-a771-5caf5fbbef74`, tenant `a00aac50-8304-4dfc-af43-11f2b9f679ad` (pipelineequipment.com), multitenant, SPA redirect URIs `http://localhost:8788/` and the dashboard URL |
| Code | https://github.com/justinpipelineequipment/thermohub (private) |

Platform admin: justin@pipelineequipment.com. Signed in successfully 2026-10-29.

## Deploying

- API: `cd backend; npx wrangler deploy` (settings in `backend/wrangler.toml`).
- Dashboard: it is **not** linked to GitHub. Copy `index.html`, `assets/` and `js/` into an empty folder,
  then `npx wrangler deploy --config <toml>` with a toml of:
  ```toml
  name = "thermohub-web"
  compatibility_date = "2025-06-01"
  [assets]
  directory = "<that folder>"
  ```
  Don't run `wrangler pages ...` from `backend/`: it now goes to Workers and uploads the API under another name.
- New PC: install Git and Node LTS (`winget install Git.Git OpenJS.NodeJS.LTS`), `npm install` in `backend/`,
  `npx wrangler login`.

## Hub (`hub/`)

Windows service, no VM. Pairs ecobees over HomeKit, runs schedules/motion/recovery locally, syncs every 15 s.
See `hub/README.md` for install and development steps. Build the installer with `hub/build.ps1` →
`hub/Output/ThermoHubHubSetup.exe` (not in git; a built copy is in the OneDrive folder).

Tested: rule unit tests; end-to-end against a local backend with simulated thermostats (discovery report,
schedule, manual hold, resume, mode, cloud outage); packaged exe runs.
**Not yet tested:** real ecobee pairing/control and the service install. Do those first, onsite, with one thermostat.

## Next steps

Progress 2026-10-29: hub installed on JUSTIN-PC (10.5.4.153), connected. First ecobee paired as `climate.pod1`
(10.5.4.150; it only appeared after **Set up HomeKit** on the thermostat). Hub is controlling it on a schedule.
Deployed: changes at the thermostat screen become a temporary hold (per profile, default 60 min, ±3° of
schedule; mode changes always put back), and thermostats can be renamed/moved on their page.
Still to confirm on pod1: a change at its screen shows "Changed at thermostat" and reverts after 60 min;
Hold Action set to "Until I change it". Idea not built yet: pair thermostats from the dashboard.
2026-10-30: hub reads ecobee's own alert text (HomeKit vendor field) every 30 min and at startup; shown on the dashboard.
A thermostat that misses 2 polls in a row (~30 s) shows "Not responding" (logged, and logged again when it recovers).
Overview "Alerts" tile counts both. build.ps1 now builds outside OneDrive (it was silently packaging an old exe).
Hub, API and dashboard all deployed.
pod1 has a live alert: "There may be a problem with the Cooling system…" (cooling running, room ~81°F).
Overview tiles are clickable (`#/list/<filter>` shows the matching thermostats).
Motion history: `motion` table (periods, kept 1 year), 24-h timeline on hover and on the thermostat page.
Sign-in: users from other M365 orgs allowed when their org owns their email domain; justin@triplehtech.com is a
platform admin. Matt@squareonecompassion.com added; admin consent for squareonecompassion.com being checked.
Next (later): Rovsun 3-zone mini split (Tuya-based). Plan: re-pair the 3 heads into Smart Life, get local keys via a
Tuya IoT developer account, then add a Tuya local driver to the hub (each head = one thermostat, no motion).
Ideas: email on new alert (paused; sender will be Microsoft 365 via Graph, recipients/triggers not decided); hub-side detection (running a long time without the temperature moving).

1. Dashboard: add the business, its Business Admin, the 10 buildings; **Setup → Pair a hub** and save the token.
2. On the site's admin PC (same VLAN as the thermostats): run the installer, paste the token, pair **one** ecobee
   (HomeKit code: Main Menu → Settings → HomeKit; remove it from Apple Home first). Set its Hold Action to
   "Until I change it".
3. Assign it a building and schedule in the dashboard, then confirm readings, setpoint changes, holds and motion.
   Send `C:\ProgramData\ThermoHub\hub.log` if anything misbehaves.
4. Then pair the rest.

Later: code-sign the installer (removes the SmartScreen warning); ecobee cloud API if ecobee grants access.
