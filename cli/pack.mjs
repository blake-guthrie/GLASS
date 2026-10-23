// Dependency-free, deterministic ZIPs plus unpacked development builds.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = process.argv[2] || 'chrome';
if (!['chrome', 'firefox', 'all'].includes(target) || process.argv.length > 3) {
  throw new Error('Usage: node cli/pack.mjs [chrome|firefox|all]');
}
const base = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

function files(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const name = `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${name}`);
    if (entry.isDirectory()) return files(name);
    return entry.isFile() && !/\.test\./.test(name) ? [name] : [];
  });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const filename = Buffer.from(name);
    const compressed = deflateRawSync(bytes, { level: 9 });
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); // UTF-8 filenames
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0x21, 12); // fixed 1980-01-01, 00:00:00
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    header.copy(record, 6, 4, 30);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

for (const browser of target === 'all' ? ['chrome', 'firefox'] : [target]) {
  const manifest = structuredClone(base);
  if (browser === 'firefox') {
    Object.assign(manifest, JSON.parse(fs.readFileSync(path.join(root, 'manifest.firefox.json'), 'utf8')));
    delete manifest.minimum_chrome_version;
  }
  const entries = [
    ['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')],
    ...[...files('icons'), ...files('src'), 'LICENSE', 'README.md', 'PRIVACY.md'].map((name) => [name, fs.readFileSync(path.join(root, name))]),
  ].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  // Only these two generated directories are replaced; source files are never moved.
  const unpacked = path.join(dist, browser);
  fs.rmSync(unpacked, { recursive: true, force: true });
  for (const [name, bytes] of entries) {
    const dest = path.join(unpacked, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
  }
  const name = `glass-extension-${base.version}${browser === 'firefox' ? '-firefox' : ''}.zip`;
  fs.writeFileSync(path.join(dist, name), zip(entries));
  console.log(`wrote dist/${name} and dist/${browser}/`);
}
