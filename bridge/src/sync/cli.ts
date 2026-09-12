/**
 * `studio-live sync <dir> [--pull] [--once] [--no-hotpatch] [--port N]` — argument parsing and
 * the long-running command. bridge/src/cli.ts can dispatch its `sync` case to runSyncCommand.
 */
import { startSync, type SyncOptions } from './index.js';

export const SYNC_USAGE = `studio-live sync <dir> [--pull] [--once] [--no-hotpatch] [--port N]

  <dir>           project directory (Rojo-compatible subset: <Service>/<Folder…>/<Name>.server.luau …)
  --pull          mirror Studio → disk instead of disk → Studio
  --once          one pass, then exit
  --no-hotpatch   never hot-patch pushed server scripts into a running playtest
  --port N        bridge port (default STUDIO_LIVE_PORT or 47800)
`;

export function parseSyncArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): SyncOptions {
  let dir: string | undefined;
  let pull = false;
  let once = false;
  let hotpatch = true;
  let port = Number(env.STUDIO_LIVE_PORT ?? 47800);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case '--pull':
        pull = true;
        break;
      case '--once':
        once = true;
        break;
      case '--no-hotpatch':
        hotpatch = false;
        break;
      case '--port': {
        const value = argv[i + 1];
        if (value === undefined) throw new Error('--port needs a value');
        port = Number(value);
        i += 1;
        break;
      }
      default:
        if (arg.startsWith('--port=')) {
          port = Number(arg.slice('--port='.length));
        } else if (arg.startsWith('-')) {
          throw new Error(`unknown option ${arg}`);
        } else if (dir === undefined) {
          dir = arg;
        } else {
          throw new Error(`unexpected argument ${arg}`);
        }
    }
  }
  if (dir === undefined) throw new Error('missing <dir>');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid port ${port}`);
  return { dir, port, pull, once, hotpatch };
}

/** Runs the sync until SIGINT / SIGTERM (or until the one-shot pass completes). */
export async function runSyncCommand(argv: readonly string[]): Promise<void> {
  let options: SyncOptions;
  try {
    options = parseSyncArgs(argv);
  } catch (err) {
    process.stderr.write(`studio-live sync: ${err instanceof Error ? err.message : String(err)}\n\n${SYNC_USAGE}`);
    process.exitCode = 2;
    return;
  }
  const handle = await startSync(options);
  if (options.once) {
    const s = handle.stats();
    process.stderr.write(`[sync] done: pushed ${s.pushed}, pulled ${s.pulled}, errors ${s.errors}\n`);
    if (s.errors > 0) process.exitCode = 1;
    return;
  }
  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.stderr.write('[sync] stopping\n');
      void handle.stop().then(resolve, resolve);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
  const s = handle.stats();
  process.stderr.write(`[sync] stopped: pushed ${s.pushed}, pulled ${s.pulled}, errors ${s.errors}\n`);
}
