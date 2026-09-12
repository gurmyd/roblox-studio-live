/**
 * Bridge-side registry of persisted playtest controllers (`playtest install` with `persist: true`).
 *
 * Studio 0.738 answers nil for every `plugin:GetSetting` key, so durability cannot live in plugin
 * settings (docs/live-test-results.md). The bridge keeps the list instead: in memory per hub
 * session and mirrored to `<home>/persist/<placeId>.json` when the place has an id, and hands it
 * to the hub as a `persist_sync` request whenever the hub connects or the list changes. The hub
 * keeps only an in-memory copy and re-installs the entries on every peer hello, as before.
 *
 * The place file is the union of every session attached to that place (an original Studio and a
 * twin opened from a copy share it): each session installs and forgets its own list, the file
 * never loses another session's entries, and a new session on the place loads the whole file.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from './log.js';

export const PERSIST_FILE_VERSION = 1;
/** Total controller code the bridge keeps per place; a controller that would exceed it is installed for the current test only. */
export const PERSIST_MAX_BYTES = 8 * 1024 * 1024;

export interface PersistedController {
  dm: string;
  name: string;
  code: string;
  /** Unix ms of the install that stored this entry. */
  at: number;
}

/** What `playtest list` shows for a persisted entry. */
export interface PersistedSummary {
  dm: string;
  name: string;
  bytes: number;
  persist: true;
  source: 'bridge';
}

export interface RememberResult {
  stored: boolean;
  /** An entry with the same dm and name was replaced. */
  replaced: boolean;
  /** Where the entry is mirrored on disk (null for a place without an id, or when the mirror write failed — see `note`). */
  file: string | null;
  note?: string;
}

interface SessionEntries {
  placeId: number | null;
  entries: PersistedController[];
  loaded: Promise<void>;
}

/** What the place file holds per entry: the session that stored it, for the record. */
interface FileEntry extends PersistedController {
  session?: string;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function validEntry(value: unknown): PersistedController | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.dm !== 'string' || typeof v.name !== 'string' || typeof v.code !== 'string') return null;
  return { dm: v.dm, name: v.name, code: v.code, at: typeof v.at === 'number' ? v.at : 0 };
}

/** Byte size of the JSON text a controller entry occupies (what the cap counts). */
function entryBytes(entry: PersistedController): number {
  return Buffer.byteLength(entry.code, 'utf8') + Buffer.byteLength(entry.dm) + Buffer.byteLength(entry.name) + 64;
}

export class PersistStore {
  private readonly sessions = new Map<string, SessionEntries>();
  /**
   * Entries of forgotten sessions, per place: they stay in the place file (the file is the union of
   * every session of that place, see flush) until a later session on the place adopts them.
   */
  private readonly orphans = new Map<number, PersistedController[]>();
  /** One write chain per file so concurrent installs never interleave their writes. */
  private readonly writes = new Map<string, Promise<boolean>>();

  /** `dir` null keeps everything in memory (tests, or a bridge without a home). */
  constructor(
    readonly dir: string | null,
    private readonly log: Logger,
  ) {}

  /** The mirror file of a place, or null when the place has no id (unsaved / local file without an id). */
  fileFor(placeId: number | null | undefined): string | null {
    if (this.dir === null || typeof placeId !== 'number' || !Number.isInteger(placeId) || placeId <= 0) return null;
    return path.join(this.dir, `${placeId}.json`);
  }

  /**
   * Binds a hub session to its place and loads the place's file once; later calls for the same
   * session return the in-memory list. A session announcing a different placeId is re-bound.
   */
  async attach(sessionId: string, placeId: number | null | undefined): Promise<PersistedController[]> {
    const place = typeof placeId === 'number' && Number.isInteger(placeId) && placeId > 0 ? placeId : null;
    let state = this.sessions.get(sessionId);
    if (!state || state.placeId !== place) {
      // Entries remembered before the session announced its place (memory-only so far) carry over
      // and take precedence over what the place file holds for the same dm + name.
      const carry = state && state.placeId === null ? state.entries : [];
      const fresh: SessionEntries = { placeId: place, entries: [], loaded: Promise.resolve() };
      fresh.loaded = this.load(fresh).then(() => {
        // A session on this place adopts what forgotten sessions left behind (already in the file).
        if (place !== null) this.orphans.delete(place);
        for (const entry of carry) {
          const index = fresh.entries.findIndex((e) => e.dm === entry.dm && e.name === entry.name);
          if (index >= 0) fresh.entries.splice(index, 1);
          fresh.entries.push(entry);
        }
      });
      this.sessions.set(sessionId, fresh);
      state = fresh;
    }
    await state.loaded;
    return state.entries;
  }

  /** Persisted controllers of a session (oldest install first); empty for an unknown session. */
  async controllers(sessionId: string): Promise<PersistedController[]> {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    await state.loaded;
    return state.entries.map((entry) => ({ ...entry }));
  }

  async list(sessionId: string): Promise<PersistedSummary[]> {
    const entries = await this.controllers(sessionId);
    return entries.map((entry) => ({ dm: entry.dm, name: entry.name, bytes: Buffer.byteLength(entry.code, 'utf8'), persist: true, source: 'bridge' }));
  }

  /** Stores (or replaces) an entry and mirrors the list to disk. */
  async remember(sessionId: string, dm: string, name: string, code: string): Promise<RememberResult> {
    const state = await this.stateOf(sessionId);
    const file = this.fileFor(state.placeId);
    const index = state.entries.findIndex((entry) => entry.dm === dm && entry.name === name);
    const candidate: PersistedController = { dm, name, code, at: Date.now() };
    const others = state.entries.filter((_, i) => i !== index);
    const total = others.reduce((sum, entry) => sum + entryBytes(entry), 0) + entryBytes(candidate);
    if (total > PERSIST_MAX_BYTES) {
      const note = `not persisted: the persisted controllers of this place would exceed ${PERSIST_MAX_BYTES / (1024 * 1024)} MB (${Math.ceil(total / 1024)} KB); installed for this test only`;
      this.log.warn(note, { session: sessionId, dm, name });
      return { stored: false, replaced: false, file, note };
    }
    if (index >= 0) state.entries.splice(index, 1);
    state.entries.push(candidate);
    const mirrored = await this.flush(state);
    if (file !== null && !mirrored) {
      // Stored for this bridge process only: say so instead of advertising a file that is not there.
      return { stored: true, replaced: index >= 0, file: null, note: `not mirrored to disk (could not write ${file}; see the bridge log): kept in memory for this bridge process only` };
    }
    return { stored: true, replaced: index >= 0, file };
  }

  /** Removes an entry; true when one existed. */
  async forget(sessionId: string, dm: string, name: string): Promise<boolean> {
    const state = await this.stateOf(sessionId);
    const index = state.entries.findIndex((entry) => entry.dm === dm && entry.name === name);
    if (index < 0) return false;
    state.entries.splice(index, 1);
    await this.flush(state);
    return true;
  }

  /**
   * Drops the in-memory list of a forgotten session. Its entries stay in the place file (kept as
   * orphans of the place so a later flush by another session on the same place preserves them)
   * until the next session on that place adopts them.
   */
  forgetSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (state && state.placeId !== null && state.entries.length > 0) {
      const kept = this.orphans.get(state.placeId) ?? [];
      for (const entry of state.entries) {
        const index = kept.findIndex((e) => e.dm === entry.dm && e.name === entry.name);
        if (index >= 0) kept.splice(index, 1);
        kept.push(entry);
      }
      this.orphans.set(state.placeId, kept);
    }
  }

  /**
   * What the place file must hold: the union of every attached session on that place plus its
   * orphans, deduped by dm + name (newest install wins). Two Studios on one place (the original and
   * a twin) therefore share the file without one session's `uninstall` erasing the other's entries.
   */
  private unionFor(placeId: number): FileEntry[] {
    const out: FileEntry[] = [];
    const put = (entry: PersistedController, session: string | undefined): void => {
      const index = out.findIndex((e) => e.dm === entry.dm && e.name === entry.name);
      if (index >= 0) {
        // Newest install wins; on a tie (a session that loaded the other's entry) the first keeps it.
        if ((out[index] as FileEntry).at >= entry.at) return;
        out.splice(index, 1);
      }
      out.push(session !== undefined ? { ...entry, session } : { ...entry });
    };
    for (const entry of this.orphans.get(placeId) ?? []) put(entry, undefined);
    for (const [id, state] of this.sessions) {
      if (state.placeId !== placeId) continue;
      for (const entry of state.entries) put(entry, id);
    }
    return out;
  }

  private async stateOf(sessionId: string): Promise<SessionEntries> {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { placeId: null, entries: [], loaded: Promise.resolve() };
      this.sessions.set(sessionId, state);
    }
    await state.loaded;
    return state;
  }

  private async load(state: SessionEntries): Promise<void> {
    const file = this.fileFor(state.placeId);
    if (!file) return;
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (!isMissing(err)) this.log.warn('could not read the persisted controllers file', { file, err });
      return;
    }
    try {
      const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as { controllers?: unknown };
      const list = Array.isArray(parsed.controllers) ? parsed.controllers : [];
      state.entries = list.map(validEntry).filter((entry): entry is PersistedController => entry !== null);
      if (state.entries.length > 0) this.log.info('persisted controllers loaded', { file, count: state.entries.length });
    } catch (err) {
      this.log.warn('persisted controllers file is not valid JSON; ignoring it', { file, err });
    }
  }

  /**
   * Mirrors the place's union list to its file (removed when empty); serialized per file, never
   * throws. Resolves true when the file reflects the list (or there is no file for this place),
   * false when the write failed (logged; the caller tells the agent).
   */
  private flush(state: SessionEntries): Promise<boolean> {
    const file = this.fileFor(state.placeId);
    if (!file || state.placeId === null) return Promise.resolve(true);
    const snapshot = { v: PERSIST_FILE_VERSION, placeId: state.placeId, updated_ms: Date.now(), controllers: this.unionFor(state.placeId) };
    const previous = this.writes.get(file) ?? Promise.resolve(true);
    const next = previous
      .then(async () => {
        if (snapshot.controllers.length === 0) {
          await fsp.rm(file, { force: true });
          return true;
        }
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(snapshot), 'utf8');
        await fsp.rename(tmp, file);
        return true;
      })
      .catch((err: unknown) => {
        this.log.warn('could not write the persisted controllers file', { file, err });
        return false;
      });
    this.writes.set(file, next);
    return next;
  }
}
