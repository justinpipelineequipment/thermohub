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

1. Dashboard: add the business, its Business Admin, the 10 buildings; **Setup → Pair a hub** and save the token.
2. On the site's admin PC (same VLAN as the thermostats): run the installer, paste the token, pair **one** ecobee
   (HomeKit code: Main Menu → Settings → HomeKit; remove it from Apple Home first). Set its Hold Action to
   "Until I change it".
3. Assign it a building and schedule in the dashboard, then confirm readings, setpoint changes, holds and motion.
   Send `C:\ProgramData\ThermoHub\hub.log` if anything misbehaves.
4. Then pair the rest.

Later: code-sign the installer (removes the SmartScreen warning); ecobee cloud API if ecobee grants access.
