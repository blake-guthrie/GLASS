import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));

test('Firefox MV3: manifest.firefox.json has compliant background and gecko ID', () => {
  const p = path.join(root, 'manifest.firefox.json');
  assert.equal(fs.existsSync(p), true, 'manifest.firefox.json must exist');
  
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(m.manifest_version, 3, 'manifest_version must be 3');
  assert.equal(Array.isArray(m.background?.scripts), true, 'background.scripts must be an array');
  assert.equal(m.background.scripts.includes('src/background.js'), true, 'background.scripts must contain src/background.js');
  assert.equal(m.background.type, 'module', 'background.type must be module');
  assert.equal(m.background.service_worker, undefined, 'service_worker must not be present in Firefox MV3 manifest');
  
  assert.ok(m.browser_specific_settings?.gecko?.id, 'gecko.id must be present for Firefox extension signing');
  assert.ok(m.browser_specific_settings.gecko.strict_min_version, 'strict_min_version must be set');
});

test('cli/pack.mjs: generates both Chrome and Firefox MV3 release archives', () => {
  const packScript = path.join(root, 'cli', 'pack.mjs');
  execFileSync('node', [packScript], { cwd: root, stdio: 'pipe' });
  
  const dist = path.join(root, 'dist');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const chromeZip = path.join(dist, `glass-extension-${manifest.version}.zip`);
  const firefoxZip = path.join(dist, `glass-extension-firefox-${manifest.version}.zip`);
  
  assert.equal(fs.existsSync(chromeZip), true, 'Chrome extension zip must be created');
  assert.equal(fs.existsSync(firefoxZip), true, 'Firefox extension zip must be created');
  assert.ok(fs.statSync(chromeZip).size > 10000, 'Chrome zip should be > 10KB');
  assert.ok(fs.statSync(firefoxZip).size > 10000, 'Firefox zip should be > 10KB');
});
