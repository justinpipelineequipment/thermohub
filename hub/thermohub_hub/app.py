# Entry point.
#   ThermoHubHub.exe                 started by Windows as the "ThermoHub Hub" service
#   ThermoHubHub.exe run [--simulate N]   run in a console (testing)
#   ThermoHubHub.exe install|start|stop|remove   manage the Windows service
import argparse
import asyncio
import logging
import sys
from logging.handlers import RotatingFileHandler

from . import web
from .devices import HomeKitDevices, SimDevices
from .engine import Engine
from .settings import Settings, data_dir


def setup_logging(console):
    handlers = [RotatingFileHandler(data_dir() / 'hub.log', maxBytes=2_000_000, backupCount=3, encoding='utf-8')]
    if console:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=logging.INFO, handlers=handlers, format='%(asctime)s %(levelname)s %(message)s')


async def main(stop, simulate=0):
    settings = Settings()
    devices = SimDevices(simulate) if simulate else HomeKitDevices(settings)
    await devices.start()
    engine = Engine(settings, devices)
    runner = await web.start(engine, devices, settings)
    logging.getLogger('thermohub').info('Hub started; setup page http://localhost:%d', web.PORT)
    try:
        await engine.run(stop)
    finally:
        await runner.cleanup()
        await devices.stop()


def run_console(simulate):
    setup_logging(console=True)

    async def go():
        stop = asyncio.Event()
        try:
            await main(stop, simulate)
        except asyncio.CancelledError:
            pass
    try:
        asyncio.run(go())
    except KeyboardInterrupt:
        pass


def service_main():
    import servicemanager
    import win32service
    import win32serviceutil

    class HubService(win32serviceutil.ServiceFramework):
        _svc_name_ = 'ThermoHubHub'
        _svc_display_name_ = 'ThermoHub Hub'
        _svc_description_ = 'Runs ThermoHub thermostat schedules locally and syncs with the ThermoHub cloud.'

        def __init__(self, args):
            super().__init__(args)
            self.loop = self.stop = None

        def SvcStop(self):
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
            if self.loop and self.stop:
                self.loop.call_soon_threadsafe(self.stop.set)

        def SvcDoRun(self):
            setup_logging(console=False)

            async def go():
                self.loop, self.stop = asyncio.get_running_loop(), asyncio.Event()
                await main(self.stop)
            asyncio.run(go())

    if len(sys.argv) == 1:
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(HubService)
        servicemanager.StartServiceCtrlDispatcher()
    else:
        win32serviceutil.HandleCommandLine(HubService)


def cli():
    if len(sys.argv) > 1 and sys.argv[1] == 'run':
        p = argparse.ArgumentParser(prog='ThermoHubHub run')
        p.add_argument('--simulate', type=int, default=0, metavar='N', help='use N simulated thermostats')
        run_console(p.parse_args(sys.argv[2:]).simulate)
    else:
        service_main()


if __name__ == '__main__':
    cli()
