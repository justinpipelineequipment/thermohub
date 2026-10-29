# ThermoHub

Multi-business dashboard for managing ecobee thermostats: global view, schedules,
manual holds, and motion-based overrides using each thermostat's built-in occupancy sensor.

## Try the demo

Double-click `index.html`. Everything is simulated — no hardware or accounts needed.
Use **Demo: signed in as** (top right) to see the site as each role.
Demo changes are saved in your browser; **Reset demo data** in the sidebar starts over.

## Architecture

```
Dashboard (Cloudflare Pages, from private GitHub repo)
   │  Microsoft 365 sign-in (multi-tenant Entra ID app, auth code + PKCE)
Cloud backend (Cloudflare Worker + D1): businesses, users, roles, schedules, audit log
   ▲  hub polls out every ~15 s: GET /hub/config, POST /hub/report (no tunnel, no open ports)
Hub per business: Home Assistant VM on the onsite admin PC
   │  HomeKit (local network, thermostat VLAN)
ecobee Smart Thermostat Enhanced (built-in occupancy sensing)
```

See [docs/GOING-LIVE.md](docs/GOING-LIVE.md) for setup. `backend/` holds the API.

ecobee's cloud API is closed to new developers, so thermostats are controlled locally via
HomeKit. Schedules and the motion rule run on the hub so they keep working if the internet drops.

## Roles

| Role | Access |
|---|---|
| Platform Admin | Everything, all businesses |
| Business Admin | Users, buildings, schedules for their business |
| Building Manager | Control and schedule assigned buildings |
| Viewer | Read-only (all buildings, or assigned ones) |

## Schedule profiles

A profile (e.g. "Office Hours") holds occupied hours per day, occupied and after-hours setpoints,
and motion-override settings. Each thermostat follows one profile; a profile can be shared by
any number of thermostats across buildings, and editing it updates all of them.
Business Admins create, edit and delete profiles. Building Managers assign profiles to thermostats
in their buildings, and can edit a profile only if every thermostat using it is in their buildings.

## Motion override rule

Set per profile. When a thermostat detects motion **outside** its profile's occupied hours, it holds
the occupied comfort settings for the configured time (default 2 hours, optionally restarting on
new motion), then returns to schedule. Manual holds are never overridden by motion.

## Smart recovery and staggered starts

Set per profile. Before occupied hours begin, each thermostat starts early by the time it needs
to reach the occupied target (degrees off ÷ its learned °F/hour rate, capped at the profile's
maximum), plus a stagger offset so thermostats in the same building don't all start together.
This keeps overnight setbacks (which save energy) from causing late recovery or a demand spike.

## Code layout

- `index.html`, `assets/styles.css` — page shell and styles (no build step)
- `js/config.js` — app name, demo mode switch
- `js/demo-data.js` — demo businesses, buildings, thermostats, users
- `js/permissions.js` — role rules (the backend will enforce the same)
- `js/store.js` — state, schedule logic, motion rule, demo simulation
- `js/views.js` — pages; `js/app.js` — router and events

## Roadmap

1. ✅ Demo dashboard (with shared schedule profiles)
2. ✅ Cloud backend: Microsoft 365 SSO, businesses/users/roles, schedule storage (code written; not yet deployed)
3. Hub setup: Home Assistant VM on admin PC, HomeKit pairing, Cloudflare Tunnel
4. Live control: real readings, setpoints, schedules and motion rule running on the hub
