"""Inspect both ZIPs independently using Python's standard ZIP/CRC reader."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
base = json.loads((root / 'manifest.json').read_text())
expected = {'manifest.json', 'LICENSE', 'README.md', 'PRIVACY.md'}
expected |= {p.relative_to(root).as_posix() for folder in ('src', 'icons')
             for p in (root / folder).rglob('*') if p.is_file() and '.test.' not in p.name}
hashes = {}
for browser in ('chrome', 'firefox'):
    suffix = '-firefox' if browser == 'firefox' else ''
    archive = root / 'dist' / f'glass-extension-{base["version"]}{suffix}.zip'
    hashes[archive] = hashlib.sha256(archive.read_bytes()).hexdigest()
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        assert set(z.namelist()) == expected
        assert len(z.namelist()) == len(expected)
        manifest = json.loads(z.read('manifest.json'))
        if browser == 'chrome':
            assert manifest == base
            assert manifest['minimum_chrome_version'] == '110'
            assert 'scripts' not in manifest['background']
        else:
            wanted = {**base, **json.loads((root / 'manifest.firefox.json').read_text())}
            del wanted['minimum_chrome_version']
            assert manifest == wanted
            assert manifest['background'] == {'scripts': ['src/background.js'], 'type': 'module'}
            assert manifest['browser_specific_settings']['gecko']['strict_min_version'] == '128.0'
            assert 'service_worker' not in manifest['background']
        for name in expected:
            assert z.read(name) == (root / 'dist' / browser / name).read_bytes()
            if name != 'manifest.json':
                assert z.read(name) == (root / name).read_bytes(), name
    print(f'{browser}: {len(expected)} exact members, CRC/source/manifest guards pass; sha256={hashes[archive]}')

# Rebuilding must preserve every archive byte, independent of file modification times.
subprocess.run([sys.argv[1] if len(sys.argv) > 1 else 'node', 'cli/pack.mjs', 'all'], cwd=root, check=True)
for archive, digest in hashes.items():
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == digest
print('Both ZIPs reproduce byte-for-byte. No tests, fixture hooks, dependencies or CI files are packaged.')
