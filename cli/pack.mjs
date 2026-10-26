// Builds dist/glass-extension-<version>.zip (Chrome) and dist/glass-extension-firefox-<version>.zip (Firefox)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const manifestChrome = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifestChrome.version;

const args = process.argv.slice(2);
const buildFirefox = args.includes('--firefox') || args.includes('--all') || args.length === 0;
const buildChrome = !args.includes('--firefox') || args.includes('--all') || args.length === 0;

function zipDirectory(sourceDir, zipFilePath, manifestOverride = null) {
  fs.rmSync(zipFilePath, { force: true });
  
  // Try system 'zip' command first
  const hasZip = spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0;
  
  if (hasZip && !manifestOverride) {
    const include = ['manifest.json', 'icons', 'src', 'LICENSE', 'README.md', 'PRIVACY.md'];
    execFileSync('zip', ['-r', '-q', zipFilePath, ...include, '-x', 'src/**/*.test.*'], { cwd: sourceDir, stdio: 'inherit' });
    return;
  }
  
  // Cross-platform python zipfile fallback
  const pyScript = `
import zipfile, os, sys

zip_path = sys.argv[1]
root_dir = sys.argv[2]
manifest_override = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != 'NONE' else None

include_items = ['icons', 'src', 'LICENSE', 'README.md', 'PRIVACY.md']

with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    # Add manifest
    if manifest_override and os.path.exists(manifest_override):
        zf.write(manifest_override, 'manifest.json')
    else:
        zf.write(os.path.join(root_dir, 'manifest.json'), 'manifest.json')
        
    for item in include_items:
        item_path = os.path.join(root_dir, item)
        if os.path.isfile(item_path):
            zf.write(item_path, item)
        elif os.path.isdir(item_path):
            for dirpath, _, filenames in os.walk(item_path):
                for f in filenames:
                    if '.test.' in f:
                        continue
                    full_p = os.path.join(dirpath, f)
                    rel_p = os.path.relpath(full_p, root_dir)
                    zf.write(full_p, rel_p)
`;
  execFileSync('python', ['-c', pyScript, zipFilePath, sourceDir, manifestOverride || 'NONE'], { stdio: 'inherit' });
}

if (buildChrome) {
  const chromeZip = path.join(dist, `glass-extension-${version}.zip`);
  zipDirectory(root, chromeZip, null);
  console.log(`wrote ${path.relative(root, chromeZip)} (${(fs.statSync(chromeZip).size / 1024).toFixed(0)} KB) [Chrome MV3]`);
}

if (buildFirefox) {
  const firefoxManifest = path.join(root, 'manifest.firefox.json');
  const firefoxZip = path.join(dist, `glass-extension-firefox-${version}.zip`);
  if (fs.existsSync(firefoxManifest)) {
    zipDirectory(root, firefoxZip, firefoxManifest);
    console.log(`wrote ${path.relative(root, firefoxZip)} (${(fs.statSync(firefoxZip).size / 1024).toFixed(0)} KB) [Firefox MV3]`);
  } else {
    console.warn(`warning: manifest.firefox.json not found, skipping Firefox package`);
  }
}
