import type { WebSocket } from 'ws';
import { makeFilter, matchesFilter, type EventFilter } from './journal.js';
import type { Logger } from './log.js';
import type { EvFrame, JsonValue } from './protocol.js';
import type { HubSession, SessionRegistry } from './session.js';

export const FANOUT_WINDOW_MS = 100;
export const FANOUT_MAX_FRAME_BYTES = 4096;
export const FANOUT_HEARTBEAT_MS = 30_000;
export const FANOUT_MAX_QUEUE = 1000;

/** Event types pushed to `/events` sockets by default (docs/protocol.md §5.1); `vision` is bridge-made (docs/vision.md). */
export const DEFAULT_PUSH_TYPES: readonly string[] = [
  'error', 'assert', 'milestone', 'custom', 'playtest', 'peer', 'controller', 'job', 'vision', 'log',
];
export const DEFAULT_PUSH_LEVELS: readonly string[] = ['warn', 'error'];
export const DEFAULT_PUSH_FILTER: EventFilter = makeFilter(DEFAULT_PUSH_TYPES, DEFAULT_PUSH_LEVELS);

function splitList(value: string | null): string[] | null {
  if (value === null) return null;
  const items = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return items.length > 0 ? items : null;
}

/** `?kinds=a,b&levels=x,y` → filter; missing params fall back to `defaults`. */
export function parseFilterQuery(params: URLSearchParams, defaults: EventFilter): EventFilter {
  const types = splitList(params.get('kinds'));
  const levels = splitList(params.get('levels'));
  return {
    types: types ? new Set(types) : defaults.types,
    levels: levels ? new Set(levels) : defaults.levels,
  };
}

const TRUNCATABLE_FIELDS = ['stack', 'detail', 'msg', 'data', 'output'] as const;

function truncateString(value: string, keep: number): string {
  return value.length > keep ? `${value.slice(0, keep)}…[+${value.length - keep} chars]` : value;
}

/** Shrinks one event until its JSON fits `maxBytes`; the last resort keeps only the envelope fields. */
export function shrinkEvent(ev: EvFrame, maxBytes: number): EvFrame {
  let current: EvFrame = ev;
  for (const keep of [1024, 256, 64]) {
    if (Buffer.byteLength(JSON.stringify(current), 'utf8') <= maxBytes) return current;
    const next: EvFrame = { ...current, truncated: true };
    for (const field of TRUNCATABLE_FIELDS) {
      const value = next[field];
      if (typeof value === 'string') next[field] = truncateString(value, keep);
      else if (value !== undefined && typeof value === 'object') next[field] = truncateString(JSON.stringify(value), keep);
    }
    current = next;
  }
  if (Buffer.byteLength(JSON.stringify(current), 'utf8') <= maxBytes) return current;
  return { v: 1, kind: 'ev', seq: ev.seq, t: ev.t, wall: ev.wall, src: ev.src, type: ev.type, truncated: true };
}

export interface BatchFrame {
  text: string;
  count: number;
}

/** Packs as many leading queue entries as fit into one `{batch,seq,dropped}` frame (always at least one). */
export function buildBatchFrame(queue: readonly EvFrame[], dropped: number, maxBytes: number = FANOUT_MAX_FRAME_BYTES): BatchFrame {
  const first = queue[0];
  if (!first) throw new RangeError('buildBatchFrame needs a non-empty queue');
  const envelope = (items: string[], seq: number): string => `{"batch":[${items.join(',')}],"seq":${seq},"dropped":${dropped}}`;
  const items: string[] = [];
  let seq = first.seq;
  for (const ev of queue) {
    const encoded = JSON.stringify(ev);
    const candidate = envelope([...items, encoded], ev.seq);
    if (Buffer.byteLength(candidate, 'utf8') > maxBytes) {
      if (items.length > 0) break;
      const overhead = Buffer.byteLength(envelope([], ev.seq), 'utf8');
      items.push(JSON.stringify(shrinkEvent(ev, maxBytes - overhead)));
      seq = ev.seq;
      break;
    }
    items.push(encoded);
    seq = ev.seq;
  }
  return { text: envelope(items, seq), count: items.length };
}

export interface FanoutClientOptions {
  maxQueue?: number;
}

export interface HeartbeatInfo {
  seq: number;
  alive: string[];
  playtest: boolean;
}

/**
 * One `/events` consumer. Events are queued and flushed at most once per
 * window (≤ 10 frames/s) in frames ≤ 4 KB; queue overflow is counted as
 * `dropped` and reported on the next frame.
 */
export class FanoutClient {
  framesSent = 0;
  private readonly queue: EvFrame[] = [];
  private timer: NodeJS.Timeout | null = null;
  private droppedSinceFrame = 0;
  private closed = false;
  private readonly maxQueue: number;

  constructor(
    private readonly send: (text: string) => void,
    readonly filter: EventFilter,
    options: FanoutClientOptions = {},
  ) {
    this.maxQueue = options.maxQueue ?? FANOUT_MAX_QUEUE;
  }

  get pending(): number {
    return this.queue.length;
  }

  get dropped(): number {
    return this.droppedSinceFrame;
  }

  push(ev: EvFrame): void {
    if (this.closed || !matchesFilter(ev, this.filter)) return;
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.droppedSinceFrame += 1;
    }
    this.queue.push(ev);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), FANOUT_WINDOW_MS);
  }

  heartbeat(info: HeartbeatInfo): void {
    if (this.closed) return;
    this.emit(JSON.stringify({ kind: 'hb', seq: info.seq, alive: info.alive, playtest: info.playtest, dropped: this.droppedSinceFrame }));
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
  }

  private flush(): void {
    this.timer = null;
    if (this.closed || this.queue.length === 0) return;
    const { text, count } = buildBatchFrame(this.queue, this.droppedSinceFrame);
    this.queue.splice(0, count);
    this.emit(text);
    if (this.queue.length > 0) this.timer = setTimeout(() => this.flush(), FANOUT_WINDOW_MS);
  }

  private emit(text: string): void {
    this.droppedSinceFrame = 0;
    this.framesSent += 1;
    this.send(text);
  }
}

export interface EventFanoutOptions {
  registry: SessionRegistry;
  log: Logger;
  heartbeatMs?: number;
}

interface Attached {
  client: FanoutClient;
  sessionId: string | null;
}

/** A bridge-made event before the envelope is stamped (`type` plus its own fields; no seq). */
export type LocalEvent = { type: string; [k: string]: unknown };

/** Bridges journal events to every `/events` WebSocket. A socket follows the active session unless it pinned one. */
export class EventFanout {
  private readonly clients = new Set<Attached>();
  private readonly registry: SessionRegistry;
  private readonly log: Logger;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private readonly startedAt = Date.now();
  /** Local counter for bridge-made events (`lseq`); journal seqs belong to the hub and are never invented. */
  private lseq = 0;
  private closed = false;

  constructor(options: EventFanoutOptions) {
    this.registry = options.registry;
    this.log = options.log.child('events');
    this.unsubscribe = this.registry.onEvent((session, ev) => {
      for (const attached of this.clients) {
        if (this.targets(attached, session)) attached.client.push(ev);
      }
    });
    this.heartbeat = setInterval(() => this.sendHeartbeats(), options.heartbeatMs ?? FANOUT_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  attach(socket: WebSocket, filter: EventFilter, sessionId: string | null): FanoutClient {
    const client = new FanoutClient((text) => {
      if (socket.readyState === socket.OPEN) socket.send(text);
    }, filter);
    const attached: Attached = { client, sessionId };
    this.clients.add(attached);
    this.log.debug('events client attached', { total: this.clients.size, session: sessionId });
    const detach = (): void => {
      client.close();
      this.clients.delete(attached);
      this.log.debug('events client detached', { total: this.clients.size });
    };
    socket.on('close', detach);
    socket.on('error', detach);
    return client;
  }

  /**
   * Delivers a bridge-made event (a `vision` answer) to every attached socket without touching any
   * journal: `seq` repeats the socket's session latest seq so no gap is signalled, `lseq` is the
   * bridge's own counter, `src` is `bridge`. Not journaled, so `events` backfill never returns it.
   */
  pushLocal(event: LocalEvent): number {
    if (this.closed) return this.lseq;
    this.lseq += 1;
    const wall = Date.now();
    const t = (wall - this.startedAt) / 1000;
    for (const attached of this.clients) {
      const session = attached.sessionId ? this.registry.get(attached.sessionId) : this.registry.active;
      const ev: EvFrame = {
        ...(event as Record<string, JsonValue | undefined>),
        v: 1,
        kind: 'ev',
        seq: session?.journal.latestSeq ?? 0,
        lseq: this.lseq,
        t,
        wall,
        src: 'bridge',
        type: event.type,
      };
      attached.client.push(ev);
    }
    return this.lseq;
  }

  close(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
    this.unsubscribe();
    for (const attached of this.clients) attached.client.close();
    this.clients.clear();
  }

  private targets(attached: Attached, session: HubSession): boolean {
    return attached.sessionId ? attached.sessionId === session.id : this.registry.active?.id === session.id;
  }

  private sendHeartbeats(): void {
    for (const attached of this.clients) {
      const session = attached.sessionId ? this.registry.get(attached.sessionId) : this.registry.active;
      attached.client.heartbeat({
        seq: session?.journal.latestSeq ?? 0,
        alive: session?.alive() ?? [],
        // The session's flag follows `playtest` events between hub heartbeats, so it lags by at most one event.
        playtest: session?.playtest?.running ?? false,
      });
    }
  }
}
