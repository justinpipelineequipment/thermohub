# ThermoHub Hub

Runs on one Windows PC per business (Windows 10/11, no VM, no Python needed). It pairs with the
ecobees over HomeKit on the local network, runs schedules, motion holds and smart recovery locally,
and syncs with the ThermoHub cloud every 15 seconds. Thermostats keep following their schedules
if the internet goes down.

## Install at a site

1. In the dashboard: **Setup → Pair a hub**, copy the token.
2. On the site PC (must be on the same network/VLAN as the thermostats, and stay on):
   run `ThermoHubHubSetup.exe`. If Windows shows "Windows protected your PC", choose
   **More info → Run anyway** (the installer is not code-signed yet).
3. The setup page opens at http://localhost:8787. Paste the hub token and click **Save token**.
   It should say **Connected**.
4. Click **Find thermostats to pair**. For each ecobee, type a name and its 8-digit HomeKit code
   (on the thermostat: Main Menu → Settings → HomeKit). A thermostat already in Apple Home must be
   removed from Apple Home first.
5. In the dashboard, the thermostats appear under **New thermostats**: assign each to a building
   and a schedule. Until a thermostat has a schedule, the hub only reports it and changes nothing.

Tip: on each ecobee, set **Main Menu → Settings → Preferences → Hold Action** to
**Until I change it**, so the hub's setpoints aren't dropped at the ecobee's own schedule changes.

The hub runs as the Windows service **ThermoHub Hub** (starts automatically, restarts if it stops).
Settings, pairings and logs are in `C:\ProgramData\ThermoHub` (`hub.log`).
Uninstall from Windows Settings → Apps.

## Develop

```powershell
py -3.12 -m venv .venv; .venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m unittest discover -s tests       # schedule/motion/recovery tests
.venv\Scripts\python run_hub.py run --simulate 3         # 3 fake thermostats, setup page on :8787
powershell -ExecutionPolicy Bypass -File build.ps1       # -> Output\ThermoHubHubSetup.exe
```

`THERMOHUB_DATA` (data folder) and `THERMOHUB_PORT` (setup page port) override the defaults for testing.
