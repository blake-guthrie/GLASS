"""Real isolated Firefox/Chromium extension tests, using only standard libraries.

Run in a disposable Linux network namespace with loopback enabled and pump.fun
mapped to 127.0.0.1. No installation, package manager, account, wallet or RPC.
"""
import base64
import errno
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)
MINT = '11111111111111111111111111111112'
ID = 'glass-launch-scanner@blake-guthrie.github.io'
UUID = 'cb8607dd-92fe-4f2e-9917-6eacbce13bd9'
results = {'checks': [], 'browsers': {}, 'limits': 'Linux desktop fixtures, no live chain calls, signing or minimum-version runtime proof.'}


def check(name, condition, detail=None):
    assert condition, f'{name}: {detail}'
    results['checks'].append({'name': name, 'detail': detail})
    print('PASS', name, json.dumps(detail) if detail is not None else '', flush=True)


def wait(fn, label, timeout=15):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(0.1)
    raise AssertionError(f'Timed out: {label}; last={last!r}')


class Driver:
    def __init__(self, kind, extension=None):
        self.kind = kind
        self.port = 4444 if kind == 'firefox' else 9515
        self.url = f'http://127.0.0.1:{self.port}'
        self.session = None
        number = len(list(OUT.glob(f'{kind}-driver-*.log'))) + 1
        self.log = (OUT / f'{kind}-driver-{number}.log').open('w')
        name = 'geckodriver' if kind == 'firefox' else 'chromedriver'
        command = [shutil.which(name), '--port', str(self.port)]
        if kind == 'firefox':
            # Mozilla's geckodriver flag, not a Firefox capability argument.
            # Needed only to operate this isolated profile's host-permission prompt.
            command.append('--allow-system-access')
        self.proc = subprocess.Popen(command, stdout=self.log, stderr=subprocess.STDOUT)
        def ready():
            try:
                return self.raw('GET', '/status')
            except urllib.error.URLError:
                return False
        wait(ready, f'{name} readiness')
        common = {'acceptInsecureCerts': True}
        if kind == 'firefox':
            common.update({'browserName': 'firefox', 'moz:firefoxOptions': {
                'args': ['-headless'],
                'prefs': {'extensions.webextensions.uuids': json.dumps({ID: UUID}),
                          'browser.shell.checkDefaultBrowser': False, 'browser.startup.page': 0,
                          'datareporting.policy.dataSubmissionEnabled': False},
            }})
        else:
            binary = shutil.which('chromium') or shutil.which('chromium-browser')
            assert binary, 'Preinstalled Chromium is required (Chrome removes --load-extension support)'
            common.update({'browserName': 'chrome', 'goog:chromeOptions': {'binary': binary, 'args': [
                '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
                '--disable-background-networking', f'--disable-extensions-except={extension}', f'--load-extension={extension}',
            ]}})
        reply = self.raw('POST', '/session', {'capabilities': {'alwaysMatch': common}})
        self.session = reply['sessionId']
        results['browsers'][kind] = reply['capabilities']
        self.call('POST', '/timeouts', {'script': 20000, 'pageLoad': 20000, 'implicit': 0})

    def raw(self, method, endpoint, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(self.url + endpoint, data=data, method=method, headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'{method} {endpoint}: {error.read().decode()}') from error
        return result.get('value')

    def call(self, method, endpoint, payload=None):
        return self.raw(method, '/session/' + self.session + endpoint, payload)

    def js(self, script, *args):
        return self.call('POST', '/execute/sync', {'script': script, 'args': list(args)})

    def promise(self, expression, *args):
        result = self.call('POST', '/execute/async', {'script': '''
            const done = arguments[arguments.length - 1];
            Promise.resolve().then(async () => { return ''' + expression + '''; })
              .then(value => done({ok:true, value}), error => done({ok:false, error:String(error)}));
        ''', 'args': list(args)})
        assert result['ok'], result
        return result.get('value')

    def message(self, obj):
        return self.promise('(globalThis.browser ?? globalThis.chrome).runtime.sendMessage(arguments[0])', obj)

    def navigate(self, url):
        self.call('POST', '/url', {'url': url})

    def click(self, selector):
        element = self.call('POST', '/element', {'using': 'css selector', 'value': selector})
        ident = element['element-6066-11e4-a52e-4f735466cecf']
        self.call('POST', f'/element/{ident}/click', {})

    def screenshot(self, name):
        (OUT / name).write_bytes(base64.b64decode(self.call('GET', '/screenshot')))

    def close(self):
        if self.session:
            try:
                self.call('DELETE', '')
            finally:
                self.session = None
        self.proc.terminate()
        self.proc.wait(timeout=10)
        self.log.close()


def permission_prompt(driver, allow):
    # Operates solely on this disposable headless Firefox's actual permission prompt.
    driver.call('POST', '/moz/context', {'context': 'chrome'})
    try:
        wait(lambda: driver.js('return !!PopupNotifications.getNotification("webextension-permissions", gBrowser.selectedBrowser);'), 'optional host prompt')
        driver.js('''const n = PopupNotifications.getNotification('webextension-permissions', gBrowser.selectedBrowser);
                     if (arguments[0]) n.mainAction.callback(); else n.secondaryActions[0].callback();
                     PopupNotifications.remove(n);''', allow)
    finally:
        driver.call('POST', '/moz/context', {'context': 'content'})


def popup_checks(driver, popup, permission_test=False):
    driver.navigate(popup)
    wait(lambda: driver.js('return document.querySelector("#rpcUrl")?.value;'), 'popup settings loaded')
    check(driver.kind + ' background module responds', driver.message({'type': 'stats'})['cachedReports'] == 0)
    driver.js('document.querySelector("#slotWindow").value = "7";')
    driver.click('#save')
    wait(lambda: driver.js('return document.querySelector("#saved").textContent === "Saved";'), 'save default host')
    driver.navigate(popup)
    wait(lambda: driver.js('return document.querySelector("#slotWindow").value === "7";'), 'settings reload')
    check(driver.kind + ' popup save/reload persists', True)
    check(driver.kind + ' asynchronous message errors are returned', driver.message({'type': 'refreshLive', 'cluster': []})['error'] == 'nothing to track')
    if permission_test:
        driver.js('document.querySelector("#rpcUrl").value = "https://rpc.example/test";')
        driver.click('#save'); permission_prompt(driver, False)
        wait(lambda: driver.js('return document.querySelector("#saved").textContent.includes("not granted");'), 'permission denial')
        driver.navigate(popup)
        wait(lambda: driver.js('return document.querySelector("#rpcUrl").value.includes("publicnode");'), 'denial preserves settings')
        check('Firefox denied optional host preserves settings', True)
        driver.js('document.querySelector("#rpcUrl").value = "https://rpc.example/test";')
        driver.click('#save'); permission_prompt(driver, True)
        wait(lambda: driver.js('return document.querySelector("#saved").textContent === "Saved";'), 'optional host saved')
        driver.navigate(popup)
        wait(lambda: driver.js('return document.querySelector("#rpcUrl").value === "https://rpc.example/test";'), 'custom host persisted')
        check('Firefox real optional host grant survives reload', driver.promise('browser.permissions.contains({origins:["https://rpc.example/*"]})'))
    driver.screenshot(driver.kind + '-popup.png')


def fixture_copy(browser, temp):
    target = temp / browser
    shutil.copytree(ROOT / 'dist' / browser, target)
    manifest = json.loads((target / 'manifest.json').read_text())
    if browser == 'firefox':
        manifest['background']['scripts'] = ['fixture-boot.js']
    else:
        manifest['background']['service_worker'] = 'fixture-boot.js'
    (target / 'manifest.json').write_text(json.dumps(manifest))
    shutil.copyfile(ROOT / 'test/browser-fixtures.js', target / 'fixture.js')
    (target / 'fixture-boot.js').write_text("import './fixture.js';\nimport './src/background.js';\n")
    for p in (ROOT / 'dist' / browser).rglob('*'):
        if p.is_file() and p.name != 'manifest.json':
            assert p.read_bytes() == (target / p.relative_to(ROOT / 'dist' / browser)).read_bytes()
    check(browser + ' fixture production source byte equality', True)
    return target


def fixture_checks(driver, popup):
    driver.navigate(popup)
    driver.promise('''(globalThis.browser ?? globalThis.chrome).storage.sync.set({settings:{
        rpcUrl:'https://solana-rpc.publicnode.com', enabled:true, operatorHistory:false,
        jitoLookup:false, liveTracking:true, slotWindow:3, earlyWindowSec:5, maxWalletProfiles:1}})''')
    driver.click('#testRpc')
    wait(lambda: driver.js('return document.querySelector("#rpcStatus").textContent.startsWith("ok");'), 'fixture RPC message')
    check(driver.kind + ' popup RPC response', True)
    # Actual extension port carries production-engine progress and completion.
    driver.js('''const api = globalThis.browser ?? globalThis.chrome;
        window.fixtureMessages = []; window.fixturePort = api.runtime.connect({name:'glass-scan'});
        window.fixturePort.onMessage.addListener(m => window.fixtureMessages.push(m));
        window.fixturePort.postMessage({type:'scan', identifier:arguments[0], hintIsMint:true, force:true});''', MINT)
    wait(lambda: driver.js('return window.fixtureMessages.some(m => m.type === "done");'), 'full fixture scan')
    messages = driver.js('return window.fixtureMessages;')
    done = next(m['report'] for m in messages if m['type'] == 'done')
    check(driver.kind + ' real port streams scan stages', len({m.get('stage') for m in messages if m['type'] == 'stage'}) >= 5)
    check(driver.kind + ' full synthetic scanner report', done.get('launch') is not None and done.get('score') is not None and not done['errors'], done['errors'])
    wait(lambda: driver.message({'type': 'stats'})['cachedReports'] == 1, 'cached fixture report')
    check(driver.kind + ' cache persists actual scan', driver.message({'type': 'getReport', 'key': MINT})['mint'] == MINT)
    driver.js('window.fixturePort.disconnect();')
    # Real content injection on an original manifest match, served only by loopback.
    popup_tab = driver.call('GET', '/window')
    page_tab = driver.call('POST', '/window/new', {'type': 'tab'})['handle']
    driver.call('POST', '/window', {'handle': page_tab})
    driver.navigate(f'https://pump.fun:8443/coin/{MINT}')
    panel = 'document.querySelector("#glass-panel-host")?.shadowRoot'
    wait(lambda: driver.js(f'return {panel}?.textContent.includes("FIX");'), 'content panel with cached report')
    driver.screenshot(driver.kind + '-panel.png')
    check(driver.kind + ' real matching-page content panel', True)
    driver.call('POST', '/window', {'handle': popup_tab})
    def fixture():
        return driver.message({'type': 'fixture'})
    wait(lambda: any(not s['closed'] and s['subscriptions'] >= 2 for s in fixture()['sockets']), 'content starts watcher')
    check(driver.kind + ' watch subscriptions over real extension port', True)
    # Forced socket loss exercises the real LiveWatcher reconnect timer.
    count = len(fixture()['sockets'])
    fixture_state = driver.message({'type': 'fixture', 'action': 'closeSockets'})
    wait(lambda: len(fixture()['sockets']) > count and any(not s['closed'] for s in fixture()['sockets']), 'watch socket reconnect')
    check(driver.kind + ' live socket reconnect', True)
    driver.call('POST', '/window', {'handle': page_tab})
    driver.js('history.pushState({}, "", "/");')
    driver.call('POST', '/window', {'handle': popup_tab})
    wait(lambda: all(s['closed'] for s in fixture()['sockets']), 'navigation watcher cleanup')
    check(driver.kind + ' non-token navigation disconnects watcher', True)
    if driver.kind == 'firefox':
        # Restart the real event background while leaving the content tab alive.
        driver.call('POST', '/window', {'handle': page_tab})
        driver.navigate(f'https://pump.fun:8443/coin/{MINT}')
        wait(lambda: driver.js(f'return {panel}?.textContent.includes("FIX");'), 'panel before background restart')
        driver.call('POST', '/window', {'handle': popup_tab})
        before = fixture()['starts']
        driver.promise('browser.runtime.getBackgroundPage().then(page => { page.location.reload(); return true; })')
        wait(lambda: fixture().get('starts', before) != before, 'event background reload')
        wait(lambda: any(not s['closed'] and s['subscriptions'] >= 2 for s in fixture()['sockets']), 'content reconnect after background reload')
        check('Firefox background reinitializes and content reconnects watcher', driver.message({'type': 'getReport', 'key': MINT})['mint'] == MINT)
        check('Firefox settings survive background restart', driver.promise('browser.storage.sync.get("settings")')['settings']['enabled'])
        driver.call('POST', '/window', {'handle': page_tab})
        driver.navigate('about:blank')
        driver.call('POST', '/window', {'handle': popup_tab})
        wait(lambda: all(s['closed'] for s in fixture()['sockets']), 'last port cleanup')
    state = fixture()
    check(driver.kind + ' no unmocked network operations', not state['unknown'], state['unknown'])
    driver.click('#clearCache')
    wait(lambda: driver.message({'type': 'stats'})['cachedReports'] == 0, 'clear report cache')
    check(driver.kind + ' popup cache clear', driver.message({'type': 'getReport', 'key': MINT}) is None)
    results[driver.kind + '_fixture'] = state


class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        data = b'<!doctype html><title>GLASS isolated fixture</title><h1>Synthetic token page</h1>'
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(data)
    def log_message(self, *args):
        pass


def main():
    # Fail before starting a browser unless the OS has no external route.
    sock = socket.socket()
    try:
        sock.connect(('192.0.2.1', 443))
    except OSError as error:
        check('OS network namespace blocks external routes', error.errno == errno.ENETUNREACH, str(error))
    else:
        raise AssertionError('Runtime tests require network isolation')
    finally:
        sock.close()
    check('fixture domain maps only to loopback', socket.gethostbyname('pump.fun') == '127.0.0.1')
    with tempfile.TemporaryDirectory(prefix='glass-browser-', dir=OUT) as tempname:
        temp = Path(tempname)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=pump.fun',
                        '-addext', 'subjectAltName=DNS:pump.fun', '-keyout', str(temp/'key.pem'), '-out', str(temp/'cert.pem')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        server = ThreadingHTTPServer(('127.0.0.1', 8443), Page)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(temp/'cert.pem', temp/'key.pem')
        server.socket = context.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        firefox = Driver('firefox')
        try:
            # Original upstream manifest must fail on Firefox's service-worker gap.
            baseline = ROOT.parent / 'baseline'
            if baseline.exists():
                control = temp / 'original'
                shutil.copytree(baseline, control, ignore=shutil.ignore_patterns('.git'))
                control_manifest = json.loads((control/'manifest.json').read_text())
                control_manifest['browser_specific_settings'] = {'gecko': {'id': ID}}
                (control/'manifest.json').write_text(json.dumps(control_manifest))
                try:
                    firefox.call('POST', '/moz/addon/install', {'path': str(control), 'temporary': True})
                except RuntimeError as error:
                    check('original service-worker-only manifest rejected by Firefox', 'service_worker' in str(error) or 'background' in str(error), str(error))
                else:
                    raise AssertionError('Original Chrome manifest unexpectedly installed in Firefox')
            ident = firefox.call('POST', '/moz/addon/install', {'path': str(ROOT/'dist/firefox'), 'temporary': True})
            check('exact Firefox package installs', ident == ID)
            popup = f'moz-extension://{UUID}/src/popup.html'
            popup_checks(firefox, popup, permission_test=True)
            copy = fixture_copy('firefox', temp)
            firefox.call('POST', '/moz/addon/install', {'path': str(copy), 'temporary': True})
            fixture_checks(firefox, popup)
        finally:
            firefox.close()
        chrome = Driver('chromium', ROOT/'dist/chrome')
        try:
            targets = wait(lambda: [t for t in chrome.call('POST', '/goog/cdp/execute', {'cmd': 'Target.getTargets', 'params': {}})['targetInfos'] if t['type'] == 'service_worker' and t['url'].startswith('chrome-extension://')], 'Chrome service worker')
            popup = targets[0]['url'].rsplit('/', 2)[0] + '/src/popup.html'
            popup_checks(chrome, popup)
        finally:
            chrome.close()
        copy = fixture_copy('chrome', temp)
        chrome = Driver('chromium', copy)
        try:
            targets = wait(lambda: [t for t in chrome.call('POST', '/goog/cdp/execute', {'cmd': 'Target.getTargets', 'params': {}})['targetInfos'] if t['type'] == 'service_worker' and t['url'].startswith('chrome-extension://')], 'fixture Chrome worker')
            popup = targets[0]['url'].rsplit('/', 1)[0] + '/src/popup.html'
            fixture_checks(chrome, popup)
        finally:
            chrome.close()
        server.shutdown()


try:
    main()
    results['status'] = 'PASS'
except Exception:
    results['status'] = 'FAIL'
    results['failure'] = traceback.format_exc()
    raise
finally:
    (OUT/'browser-results.json').write_text(json.dumps(results, indent=2) + '\n')
