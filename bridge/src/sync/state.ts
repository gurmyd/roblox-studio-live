/**
 * Source normalisation, the content hash shared with the Luau side, and the
 * `<dir>/.studio-live-sync.json` record of what was last synced per file.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

export const STATE_FILE = '.studio-live-sync.json';

/** Strips a UTF-8 BOM (a syntax error for the Luau parser) and folds CRLF to LF. */
export function normalizeSource(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return noBom.replace(/\r\n/g, '\n');
}

const HASH_MOD = 4294967296;

/**
 * `<byteLength>-<h>` where h = Σ over UTF-8 bytes of (h * 31 + byte) mod 2^32.
 * The Luau programs (luau.ts) compute exactly the same over the normalised source,
 * so hashes computed in Studio and on disk are comparable without shipping sources.
 */
export function hashSource(normalized: string): string {
  const bytes = Buffer.from(normalized, 'utf8');
  let h = 0;
  for (const b of bytes) h = (h * 31 + b) % HASH_MOD;
  return `${bytes.length}-${h}`;
}

export interface FileRecord {
  hash: string;
  mtime: number;
}

export interface SyncState {
  version: 1;
  files: Record<string, FileRecord>;
}

export function emptyState(): SyncState {
  return { version: 1, files: {} };
}

export async function loadState(dir: string): Promise<SyncState> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(dir, STATE_FILE), 'utf8');
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(text) as Partial<SyncState>;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.files !== 'object' || parsed.files === null) return emptyState();
    const files: Record<string, FileRecord> = {};
    for (const [rel, rec] of Object.entries(parsed.files)) {
      if (rec && typeof rec.hash === 'string') files[rel] = { hash: rec.hash, mtime: typeof rec.mtime === 'number' ? rec.mtime : 0 };
    }
    return { version: 1, files };
  } catch {
    return emptyState();
  }
}

/** Writes through a temp file so a crash never leaves a half-written record. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data, 'utf8');
  await fsp.rename(tmp, file);
}

export async function saveState(dir: string, state: SyncState): Promise<void> {
  const sorted: Record<string, FileRecord> = {};
  for (const rel of Object.keys(state.files).sort()) sorted[rel] = state.files[rel] as FileRecord;
  await writeFileAtomic(path.join(dir, STATE_FILE), `${JSON.stringify({ version: 1, files: sorted }, null, 1)}\n`);
}
