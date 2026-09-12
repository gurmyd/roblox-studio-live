import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from './log.js';
import type { BundlePayload } from './protocol.js';

export const BUNDLE_ENTRY = 'runtime/init';
const DEFAULT_DEBOUNCE_MS = 300;
const MODULE_EXTENSION = '.luau';

export interface BundleInfo extends BundlePayload {
  loadedAt: number;
  dir: string;
}

export function hashModules(modules: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const key of Object.keys(modules).sort()) {
    hash.update(key);
    hash.update('\0');
    hash.update(modules[key] ?? '');
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex')}`;
}

async function walk(dir: string, relative: string, out: Record<string, string>): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(abs, rel, out);
    } else if (entry.isFile() && entry.name.endsWith(MODULE_EXTENSION)) {
      out[`runtime/${rel.slice(0, -MODULE_EXTENSION.length)}`] = await fsp.readFile(abs, 'utf8');
    }
  }
}

/** Reads plugin/runtime/**\/*.luau keyed `runtime/<relative path without extension>`. A missing directory yields {}. */
export async function readRuntimeModules(dir: string): Promise<Record<string, string>> {
  const modules: Record<string, string> = {};
  try {
    await walk(dir, '', modules);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return modules;
}

export function buildBundle(modules: Record<string, string>, dir: string, now: number = Date.now()): BundleInfo {
  return { hash: hashModules(modules), entry: BUNDLE_ENTRY, modules, loadedAt: now, dir };
}

export interface BundleProviderOptions {
  dir: string;
  log: Logger;
  /** Watch the runtime directory and reload on change (STUDIO_LIVE_DEV=1). */
  watch?: boolean;
  debounceMs?: number;
}

export type BundleListener = (bundle: BundleInfo) => void;

/** Holds the current runtime bundle and, in dev mode, reloads it when files change. */
export class BundleProvider {
  private bundle: BundleInfo;
  private readonly dir: string;
  private readonly log: Logger;
  private readonly watchEnabled: boolean;
  private readonly debounceMs: number;
  private readonly listeners = new Set<BundleListener>();
  private watcher: fs.FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private reloading: Promise<void> | null = null;
  private reloadAgain = false;

  constructor(options: BundleProviderOptions) {
    this.dir = options.dir;
    this.log = options.log;
    this.watchEnabled = options.watch ?? false;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.bundle = buildBundle({}, options.dir);
  }

  get current(): BundleInfo {
    return this.bundle;
  }

  async load(): Promise<BundleInfo> {
    const modules = await readRuntimeModules(this.dir);
    const count = Object.keys(modules).length;
    if (count === 0) {
      this.log.warn('runtime bundle is empty; serving an empty bundle until plugin/runtime/**/*.luau exists', { dir: this.dir });
    } else if (!(BUNDLE_ENTRY in modules)) {
      this.log.warn(`runtime bundle has no entry module "${BUNDLE_ENTRY}"`, { dir: this.dir, modules: count });
    }
    this.bundle = buildBundle(modules, this.dir);
    this.log.info('runtime bundle loaded', { modules: count, hash: this.bundle.hash });
    if (this.watchEnabled && !this.watcher) this.startWatching();
    return this.bundle;
  }

  onChange(listener: BundleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.watcher?.close();
    this.watcher = null;
    this.listeners.clear();
  }

  private startWatching(): void {
    // Watch the parent when the runtime dir does not exist yet so its creation is picked up too.
    const target = fs.existsSync(this.dir) ? this.dir : path.dirname(this.dir);
    if (!fs.existsSync(target)) {
      this.log.warn('dev watch disabled: directory does not exist', { dir: target });
      return;
    }
    try {
      this.watcher = fs.watch(target, { recursive: true, persistent: false }, () => this.scheduleReload());
      this.watcher.on('error', (err) => this.log.warn('bundle watcher error', { err }));
      this.log.info('watching runtime for changes', { dir: target });
    } catch (err) {
      this.log.warn('dev watch unavailable', { err });
    }
  }

  private scheduleReload(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.reload();
    }, this.debounceMs);
  }

  private reload(): Promise<void> {
    if (this.reloading) {
      this.reloadAgain = true;
      return this.reloading;
    }
    this.reloading = (async () => {
      try {
        const previous = this.bundle.hash;
        const next = await this.load();
        if (next.hash !== previous) {
          for (const listener of this.listeners) listener(next);
        }
      } catch (err) {
        this.log.warn('bundle reload failed', { err });
      } finally {
        this.reloading = null;
        if (this.reloadAgain) {
          this.reloadAgain = false;
          this.scheduleReload();
        }
      }
    })();
    return this.reloading;
  }
}
