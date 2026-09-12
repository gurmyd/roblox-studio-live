/**
 * Directory scanning and change detection for the push direction. fs.watch only says
 * "something happened"; every batch is confirmed by a stat-based rescan, so partial or
 * misreported events never lose an edit.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isIgnoredRel } from './layout.js';

export interface ScannedFile {
  rel: string;
  mtimeMs: number;
  size: number;
}

/** Every `.luau` file under `dir` (dot-directories and dot-files skipped), as POSIX relative paths. */
export async function scanDir(dir: string): Promise<Map<string, ScannedFile>> {
  const out = new Map<string, ScannedFile>();
  const walk = async (abs: string, rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile() && entry.name.endsWith('.luau')) {
        try {
          const stat = await fsp.stat(childAbs);
          out.set(childRel, { rel: childRel, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          // Deleted between readdir and stat: the next rescan will settle it.
        }
      }
    }
  };
  await walk(dir, '');
  return out;
}

export interface Watcher {
  close(): void;
}

/**
 * Recursive fs.watch with a polling fallback (platforms without recursive watch). `onChange`
 * is called with a relative path when known; callers rescan rather than trusting it.
 */
export function watchDir(dir: string, onChange: (rel: string | null) => void, pollMs: number): Watcher {
  try {
    const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      const rel = typeof filename === 'string' ? filename.split(path.sep).join('/') : filename ? String(filename) : null;
      if (rel !== null && isIgnoredRel(rel) && !looksLikeDirectory(rel)) return;
      onChange(rel);
    });
    watcher.on('error', () => {
      // A broken watcher degrades to polling below rather than crashing the sync.
      watcher.close();
      startPolling();
    });
    let poller: Watcher | null = null;
    const startPolling = (): void => {
      poller ??= pollDir(dir, onChange, pollMs);
    };
    return {
      close() {
        watcher.close();
        poller?.close();
      },
    };
  } catch {
    return pollDir(dir, onChange, pollMs);
  }
}

/** An event path with no extension may be a directory (rename/move); those must trigger a rescan. */
function looksLikeDirectory(rel: string): boolean {
  const base = rel.split('/').pop() ?? '';
  return !base.includes('.');
}

function pollDir(dir: string, onChange: (rel: string | null) => void, pollMs: number): Watcher {
  let last: Map<string, ScannedFile> | null = null;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    const now = await scanDir(dir);
    if (last) {
      let changed = false;
      if (now.size !== last.size) changed = true;
      else {
        for (const [rel, file] of now) {
          const prev = last.get(rel);
          if (!prev || prev.mtimeMs !== file.mtimeMs || prev.size !== file.size) {
            changed = true;
            break;
          }
        }
      }
      if (changed) onChange(null);
    }
    last = now;
    if (!stopped) timer = setTimeout(() => void tick(), pollMs);
  };
  let timer: NodeJS.Timeout = setTimeout(() => void tick(), pollMs);
  return {
    close() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** Coalesces bursts of triggers into one callback `delayMs` after the last trigger. */
export class Debouncer {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly fn: () => void,
  ) {}

  trigger(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fn();
    }, this.delayMs);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
