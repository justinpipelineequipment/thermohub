# Local setup page (http://localhost:8787): hub token, pairing thermostats, status.
# Bound to 127.0.0.1 only. Requests from other sites are refused so a web page can't change hub settings.
import html
import os
import time
from datetime import datetime

from aiohttp import web

from . import VERSION

PORT = int(os.environ.get('THERMOHUB_PORT', '8787'))
ALLOWED_HOSTS = {f'127.0.0.1:{PORT}', f'localhost:{PORT}'}

CSS = """
body{font-family:Segoe UI,system-ui,sans-serif;margin:0;background:#f5f6f8;color:#1d2330}
main{max-width:880px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px}
.card{background:#fff;border:1px solid #dde1e7;border-radius:8px;padding:16px;margin:16px 0}
.muted{color:#5b6475;font-size:13px}.ok{color:#17803d}.bad{color:#b42318}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eef0f3}
input{font:inherit;padding:6px 8px;border:1px solid #c4cad4;border-radius:6px}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #1f5fbf;background:#1f5fbf;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#1f5fbf}form.inline{display:inline}
.msg{padding:10px 12px;border-radius:6px;background:#e8f1fd}.msg.err{background:#fdecea}
"""

e = lambda v: html.escape('' if v is None else str(v))  # noqa: E731


@web.middleware
async def guard(request, handler):
    if request.host not in ALLOWED_HOSTS:
        return web.Response(status=403, text='Open this page as http://localhost:%d' % PORT)
    origin = request.headers.get('Origin')
    if request.method == 'POST' and origin and origin.split('://', 1)[-1] not in ALLOWED_HOSTS:
        return web.Response(status=403, text='Cross-site request refused.')
    return await handler(request)


def page(body, msg=None, err=False):
    note = f'<p class="msg{" err" if err else ""}">{e(msg)}</p>' if msg else ''
    return web.Response(content_type='text/html', text=f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ThermoHub Hub</title><style>{CSS}</style></head>
<body><main><h1>ThermoHub Hub</h1><p class="muted">Version {VERSION} · runs in the background on this PC</p>
{note}{body}</main></body></html>""")


def ago(ms):
    if not ms:
        return 'never'
    s = int(time.time() - ms / 1000)
    return f'{s} s ago' if s < 120 else datetime.fromtimestamp(ms / 1000).strftime('%b %d %I:%M %p')


def make_app(engine, devices, settings):
    async def index(request, msg=None, err=False):
        st = engine.status
        token_set = bool(settings.token)
        rows = []
        for d in devices.list():
            t = engine.thermos.get(d.entity)
            r = t.reading if t else None
            reading = (f"{e(r['temp'])}° · {e(r['mode'])} · heat {e(r['heat'])}° / cool {e(r['cool'])}°"
                       f" · {'motion' if r['occupied'] else 'no motion'}") if r else '<span class="bad">not responding</span>'
            rows.append(f"""<tr><td>{e(d.name)}<div class="muted">{e(d.entity)}</div></td><td>{reading}</td>
<td><form class="inline" method="post" action="/unpair" onsubmit="return confirm('Unpair {e(d.name)}?')">
<input type="hidden" name="alias" value="{e(d.alias)}"><button class="secondary">Unpair</button></form></td></tr>""")
        table = (f'<table><tr><th>Thermostat</th><th>Now</th><th></th></tr>{"".join(rows)}</table>' if rows
                 else '<p class="muted">No thermostats paired yet.</p>')
        return page(f"""
<div class="card"><h2>Cloud connection</h2>
<p class="{'ok' if st['cloudOk'] else 'bad'}">{e(st['cloud'])}</p>
<p class="muted">Last sync: {ago(st['lastSync'])} · {e(settings.api_url)}</p>
<form method="post" action="/token"><p>Hub token (from the dashboard: Setup → Pair a hub)</p>
<input name="token" type="password" size="50" placeholder="{'Token saved. Paste a new one to replace it' if token_set else 'Paste hub token'}" required>
<button>Save token</button></form></div>
<div class="card"><h2>Thermostats on this hub</h2>{table}
<p style="margin-top:12px"><a href="/discover"><button class="secondary" type="button">Find thermostats to pair</button></a></p></div>
""", msg, err)

    async def discover(request):
        found = await devices.discover()
        items = ''.join(f"""<tr><td>{e(f['name'])}<div class="muted">{e(f['id'])}</div></td><td>
<form method="post" action="/pair"><input type="hidden" name="id" value="{e(f['id'])}">
<input name="name" value="{e(f['name'])}" size="22" title="Name shown in the dashboard">
<input name="code" placeholder="HomeKit code" size="12" required pattern="[0-9 \\-]{{8,11}}">
<button>Pair</button></form></td></tr>""" for f in found)
        body = (f'<table><tr><th>Found</th><th>Name it and enter its 8-digit HomeKit code</th></tr>{items}</table>'
                if found else '<p>No unpaired thermostats found yet. Discovery keeps running, so try again in a minute.</p>')
        return page(f"""<div class="card"><h2>Unpaired thermostats on the network</h2>{body}
<p class="muted">The HomeKit code is on the thermostat: Main Menu → Settings → HomeKit (or Reset HomeKit). A thermostat
already added to Apple Home must be removed from it first. This PC must be on the same network/VLAN as the thermostats.</p>
<p><a href="/">← Back</a></p></div>""")

    async def set_token(request):
        token = (await request.post()).get('token', '').strip()
        if len(token) < 20:
            return await index(request, 'That does not look like a hub token.', True)
        settings.data['token'] = token
        settings.save()
        await engine.tick()
        return await index(request, 'Token saved. ' + engine.status['cloud'], not engine.status['cloudOk'])

    async def pair(request):
        f = await request.post()
        try:
            entity = await devices.pair(f.get('id', ''), f.get('code', ''), f.get('name', ''))
        except Exception as ex:  # noqa: BLE001 - show the pairing error to the installer
            return await index(request, f'Pairing failed: {ex or type(ex).__name__}', True)
        await engine.tick()
        return await index(request, f'Paired as {entity}. In the dashboard, assign it to a building and a schedule.')

    async def unpair(request):
        alias = (await request.post()).get('alias', '')
        await devices.unpair(alias)
        return await index(request, 'Thermostat unpaired. It stays in the dashboard until you remove it there.')

    app = web.Application(middlewares=[guard])
    app.add_routes([web.get('/', index), web.get('/discover', discover), web.post('/token', set_token),
                    web.post('/pair', pair), web.post('/unpair', unpair)])
    return app


async def start(engine, devices, settings):
    runner = web.AppRunner(make_app(engine, devices, settings))
    await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', PORT).start()
    return runner
