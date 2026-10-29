# Persistent hub settings and state, kept in %ProgramData%\ThermoHub (or THERMOHUB_DATA for testing).
import json
import os
import threading
from pathlib import Path

DEFAULT_API_URL = 'https://thermohub-api.thermohub-api.workers.dev'


def data_dir():
    d = Path(os.environ.get('THERMOHUB_DATA') or Path(os.environ.get('PROGRAMDATA', '.')) / 'ThermoHub')
    d.mkdir(parents=True, exist_ok=True)
    return d


class JsonFile:
    """A small JSON document saved atomically on every change."""

    def __init__(self, name, default):
        self.path = data_dir() / name
        self._lock = threading.Lock()
        try:
            self.data = json.loads(self.path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            self.data = default

    def save(self):
        with self._lock:
            tmp = self.path.with_suffix('.tmp')
            tmp.write_text(json.dumps(self.data, indent=2), encoding='utf-8')
            os.replace(tmp, self.path)


class Settings(JsonFile):
    # token: hub token from the dashboard (Setup -> Pair a hub)
    # pairings: {alias: {"entity", "name", "data": aiohomekit pairing data}}
    def __init__(self):
        super().__init__('settings.json', {})
        self.data.setdefault('apiUrl', DEFAULT_API_URL)
        self.data.setdefault('token', '')
        self.data.setdefault('pairings', {})

    @property
    def api_url(self):
        return self.data['apiUrl'].rstrip('/')

    @property
    def token(self):
        return self.data['token']
