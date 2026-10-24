import fs from 'node:fs/promises';
import path from 'node:path';
import { isBase58Address } from '../src/lib/base58.js';

export async function atomicJson(file, value) {
  const temp = `${file}.tmp`, handle = await fs.open(temp, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, file);
}

export class WorkerStore {
  constructor(directory) { this.directory = path.resolve(directory); this.locked = false; }
  async open() {
    await fs.mkdir(path.join(this.directory, 'reports'), { recursive: true, mode: 0o700 });
    this.lockPath = path.join(this.directory, 'worker.lock');
    try { this.lock = await fs.open(this.lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await fs.readFile(this.lockPath, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('worker-lock-invalid');
      try { process.kill(pid, 0); throw new Error('worker-already-running'); }
      catch (check) { if (check.code !== 'ESRCH') throw check; }
      await fs.unlink(this.lockPath);
      this.lock = await fs.open(this.lockPath, 'wx', 0o600);
    }
    await this.lock.writeFile(String(process.pid)); this.locked = true;
    try {
      this.state = JSON.parse(await fs.readFile(path.join(this.directory, 'state.json'), 'utf8'));
      if (this.state.version !== 1 || !this.state.pending || !this.state.jobs || !Array.isArray(this.state.seen)) throw new Error('unsupported-worker-state');
    } catch (error) {
      if (error.code !== 'ENOENT') { await this.close(); throw error; }
      this.state = { version: 1, startedAt: Date.now(), initialized: false, checkpoint: null, cycle: null,
        pending: {}, jobs: {}, seen: [], cursorGaps: 0, lastPollAt: null, lastError: null };
    }
    return this;
  }
  async save() { await atomicJson(path.join(this.directory, 'state.json'), this.state); }
  reportPath(mint) {
    if (!isBase58Address(mint)) throw new Error('invalid-mint');
    return path.join(this.directory, 'reports', `${mint}.json`);
  }
  async readReport(mint) {
    try { return JSON.parse(await fs.readFile(this.reportPath(mint), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async writeReport(snapshot) { await atomicJson(this.reportPath(snapshot.mint), snapshot); }
  async removeReport(mint) { await fs.unlink(this.reportPath(mint)).catch((e) => { if (e.code !== 'ENOENT') throw e; }); }
  async close() {
    if (!this.locked) return;
    this.locked = false; await this.lock.close(); await fs.unlink(this.lockPath);
  }
}
