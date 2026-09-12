import type { EvFrame } from './protocol.js';

export const JOURNAL_CAPACITY = 10_000;
export const DEFAULT_BACKFILL_LIMIT = 500;
export const MAX_BACKFILL_LIMIT = 2000;

/** `types` filters on the event `type` field (the query string calls them `kinds`); `levels` applies to `log` events only. */
export interface EventFilter {
  types: ReadonlySet<string> | null;
  levels: ReadonlySet<string> | null;
}

export const NO_FILTER: EventFilter = { types: null, levels: null };

export function makeFilter(types?: readonly string[] | null, levels?: readonly string[] | null): EventFilter {
  return {
    types: types && types.length > 0 ? new Set(types) : null,
    levels: levels && levels.length > 0 ? new Set(levels) : null,
  };
}

export function matchesFilter(ev: EvFrame, filter: EventFilter): boolean {
  if (filter.types && !filter.types.has(ev.type)) return false;
  if (ev.type === 'log' && filter.levels) {
    const level = typeof ev.level === 'string' ? ev.level : 'print';
    if (!filter.levels.has(level)) return false;
  }
  return true;
}

export interface Backfill {
  events: EvFrame[];
  /** Seq to pass as `since` next time. */
  cursor: number;
  /** Events after `since` that the ring had already evicted. */
  dropped: number;
  /** True when `limit` cut the result; more events are available after `cursor`. */
  truncated: boolean;
}

export interface JournalStats {
  seq: number;
  oldest: number;
  size: number;
  capacity: number;
  evicted: number;
  gaps: number;
}

export type JournalSubscriber = (ev: EvFrame) => void;

/**
 * Per-session event ring. Seq numbers come from the hub and are monotonic;
 * re-delivered events (seq ≤ latest) are dropped, which is the dedup the
 * protocol asks for after `relinked()`.
 */
export class Journal {
  private readonly buffer: Array<EvFrame | undefined>;
  private start = 0;
  private count = 0;
  private latest = 0;
  private firstSeen = 0;
  private evictedCount = 0;
  private gapCount = 0;
  private readonly subscribers = new Set<JournalSubscriber>();

  constructor(readonly capacity: number = JOURNAL_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.buffer = new Array<EvFrame | undefined>(capacity).fill(undefined);
  }

  get latestSeq(): number {
    return this.latest;
  }

  get oldestSeq(): number {
    return this.count === 0 ? 0 : this.at(0).seq;
  }

  get size(): number {
    return this.count;
  }

  get evicted(): number {
    return this.evictedCount;
  }

  /** Seq numbers skipped on ingest — events the hub emitted that never reached the bridge. */
  get gaps(): number {
    return this.gapCount;
  }

  ingest(ev: EvFrame): boolean {
    if (ev.seq <= this.latest) return false;
    if (this.count === 0 && this.firstSeen === 0) {
      this.firstSeen = ev.seq;
    } else if (ev.seq > this.latest + 1) {
      this.gapCount += ev.seq - this.latest - 1;
    }
    if (this.count === this.capacity) {
      this.start = (this.start + 1) % this.capacity;
      this.evictedCount += 1;
    } else {
      this.count += 1;
    }
    this.buffer[(this.start + this.count - 1) % this.capacity] = ev;
    this.latest = ev.seq;
    for (const fn of this.subscribers) {
      try {
        fn(ev);
      } catch {
        // a misbehaving subscriber must not break ingestion for the others
      }
    }
    return true;
  }

  backfill(since: number, filter: EventFilter = NO_FILTER, limit: number = DEFAULT_BACKFILL_LIMIT): Backfill {
    const events: EvFrame[] = [];
    let truncated = false;
    let index = this.firstIndexAfter(since);
    for (; index < this.count; index += 1) {
      const ev = this.at(index);
      if (!matchesFilter(ev, filter)) continue;
      if (events.length >= limit) {
        truncated = true;
        break;
      }
      events.push(ev);
    }
    const last = events[events.length - 1];
    const cursor = truncated && last ? last.seq : last ? Math.max(last.seq, this.latest) : Math.max(since, this.latest);
    return { events, cursor, dropped: this.droppedAfter(since), truncated };
  }

  /**
   * Long-poll: resolves with the backfill as soon as at least one matching
   * event exists after `since`, or with an empty result at `timeoutMs`.
   */
  waitFor(
    since: number,
    filter: EventFilter = NO_FILTER,
    timeoutMs = 0,
    limit: number = DEFAULT_BACKFILL_LIMIT,
    signal?: AbortSignal,
  ): Promise<Backfill> {
    const immediate = this.backfill(since, filter, limit);
    if (immediate.events.length > 0 || timeoutMs <= 0 || signal?.aborted) return Promise.resolve(immediate);

    return new Promise<Backfill>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', finish);
        resolve(this.backfill(since, filter, limit));
      };
      const timer = setTimeout(finish, timeoutMs);
      const unsubscribe = this.subscribe((ev) => {
        if (ev.seq > since && matchesFilter(ev, filter)) finish();
      });
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  subscribe(fn: JournalSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  stats(): JournalStats {
    return {
      seq: this.latest,
      oldest: this.oldestSeq,
      size: this.count,
      capacity: this.capacity,
      evicted: this.evictedCount,
      gaps: this.gapCount,
    };
  }

  private at(index: number): EvFrame {
    const ev = this.buffer[(this.start + index) % this.capacity];
    if (!ev) throw new RangeError(`journal index ${index} out of range`);
    return ev;
  }

  /** Binary search over the (monotonic) ring for the first event with seq > since. */
  private firstIndexAfter(since: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.at(mid).seq <= since) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private droppedAfter(since: number): number {
    if (this.count === 0) return 0;
    const oldest = this.oldestSeq;
    const floor = Math.max(since, this.firstSeen - 1);
    return Math.max(0, oldest - 1 - floor);
  }
}
