#!/usr/bin/env node
// Standalone entry: node dist/bridge/sync/main.js <dir> [--pull] [--once] [--no-hotpatch] [--port N]
import { runSyncCommand } from './cli.js';

runSyncCommand(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`studio-live sync: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
