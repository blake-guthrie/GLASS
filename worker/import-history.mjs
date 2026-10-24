#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkerStore } from './store.mjs';
import { LaunchHistory } from './history.mjs';
import { extractLaunchRecord } from '../src/lib/scan/similar.js';
import { INDEX_ENGINE } from '../src/lib/shared-index.js';

/** Offline operator ingestion. Stop the worker first: the same exclusive data-directory lock applies. */
export async function importHistory(args = process.argv.slice(2)) {
  const configPath = args[args.indexOf('--config')+1], inputPath = args[args.indexOf('--input')+1];
  if (!args.includes('--config') || !args.includes('--input') || !configPath || !inputPath) throw new Error('config and input required');
  const config = JSON.parse(await fs.readFile(configPath,'utf8'));
  if (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) throw new Error('absolute dataDir required');
  const stat = await fs.stat(inputPath); if (stat.size > 16*1024*1024) throw new Error('import-file-too-large');
  const input = JSON.parse(await fs.readFile(inputPath,'utf8'));
  if (input.schema !== 1 || input.engine !== INDEX_ENGINE || !Array.isArray(input.reports) || !Array.isArray(input.updates)
    || input.reports.length+input.updates.length > 500) throw new Error('invalid-import-format');
  // Inputs are full reports plus their actual scan profile/quote. A public snapshot has insufficient features.
  const records = input.reports.map((v) => {
    if (!v.settings || !v.source || !v.quoteMint) throw new Error('missing-report-provenance');
    return extractLaunchRecord(v.report,{ settings:v.settings,source:v.source,quoteMint:v.quoteMint });
  });
  const store = await new WorkerStore(config.dataDir).open();
  try {
    const history = await new LaunchHistory(store.directory,config.history).open();
    return await history.importBatch({ records,updates:input.updates });
  } finally { await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  importHistory().then((result) => console.log(JSON.stringify(result))).catch(() => {
    console.error('History import rejected: check input, provenance, bounds and worker lock. No report or credentials are printed.'); process.exitCode = 1;
  });
}
