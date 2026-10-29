# ThermoHub cloud API client (outbound HTTPS only).
import aiohttp

from . import VERSION


class CloudError(Exception):
    pass


class Cloud:
    def __init__(self, settings):
        self.settings = settings
        self._session = None

    async def _call(self, method, path, body=None):
        if not self.settings.token:
            raise CloudError('No hub token yet. Paste it on the hub setup page.')
        if self._session is None:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20))
        headers = {'Authorization': f'Bearer {self.settings.token}', 'User-Agent': f'ThermoHub-Hub/{VERSION}'}
        try:
            async with self._session.request(method, self.settings.api_url + path, json=body, headers=headers) as r:
                data = await r.json(content_type=None)
                if r.status == 401:
                    raise CloudError('The cloud rejected the hub token. Pair the hub again in the dashboard.')
                if r.status >= 400:
                    raise CloudError(f'Cloud error {r.status}: {(data or {}).get("error", "")}')
                return data
        except (aiohttp.ClientError, TimeoutError, ValueError) as e:
            raise CloudError(f'Cannot reach the cloud: {e or type(e).__name__}') from e

    async def config(self):
        return await self._call('GET', '/hub/config')

    async def report(self, thermostats, events):
        r = await self._call('POST', '/hub/report', {
            'version': f'ThermoHub Hub {VERSION}', 'thermostats': thermostats, 'events': events})
        return r.get('configVersion')

    async def close(self):
        if self._session:
            await self._session.close()
