import { PROTO_VERSION, type ChunkFrame } from './protocol.js';

/**
 * Data characters per L1 chunk. A slice of an already-JSON-encoded frame gets
 * escaped again inside the chunk frame (at most 2x), so 128 K chars keeps each
 * chunk frame under the 512 KB threshold even in the worst case.
 */
export const CHUNK_DATA_CHARS = 128 * 1024;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

let chunkCounter = 0;

export function nextChunkId(): string {
  chunkCounter += 1;
  return `c-${chunkCounter}`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Splits an encoded frame into `chunk` frames without cutting a surrogate pair. */
export function splitFrame(text: string, cid: string, maxChars: number = CHUNK_DATA_CHARS): ChunkFrame[] {
  if (maxChars < 2) throw new RangeError('maxChars must be at least 2');
  const slices: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + maxChars, text.length);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    slices.push(text.slice(pos, end));
    pos = end;
  }
  if (slices.length === 0) slices.push('');
  return slices.map((data, i) => ({ v: PROTO_VERSION, kind: 'chunk', cid, i, n: slices.length, data }));
}

interface PartialFrame {
  parts: Array<string | undefined>;
  received: number;
  bytes: number;
  startedAt: number;
}

export interface ChunkAssemblerOptions {
  staleMs?: number;
  maxTotalBytes?: number;
  now?: () => number;
}

/** Reassembles inbound chunk frames per `cid`. Returns the full frame text when the last part arrives. */
export class ChunkAssembler {
  private readonly partials = new Map<string, PartialFrame>();
  private readonly staleMs: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;

  constructor(options: ChunkAssemblerOptions = {}) {
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.now = options.now ?? Date.now;
  }

  get pending(): number {
    return this.partials.size;
  }

  accept(chunk: ChunkFrame): string | null {
    this.sweep();
    let partial = this.partials.get(chunk.cid);
    if (partial && partial.parts.length !== chunk.n) {
      // A cid reused with a different part count means the sender restarted; start over.
      this.partials.delete(chunk.cid);
      partial = undefined;
    }
    if (!partial) {
      partial = { parts: new Array<string | undefined>(chunk.n).fill(undefined), received: 0, bytes: 0, startedAt: this.now() };
      this.partials.set(chunk.cid, partial);
    }
    if (partial.parts[chunk.i] === undefined) {
      partial.received += 1;
    }
    partial.parts[chunk.i] = chunk.data;
    partial.bytes += chunk.data.length;
    if (partial.bytes > this.maxTotalBytes) {
      this.partials.delete(chunk.cid);
      throw new RangeError(`chunked frame ${chunk.cid} exceeds ${this.maxTotalBytes} bytes`);
    }
    if (partial.received < chunk.n) return null;
    this.partials.delete(chunk.cid);
    return partial.parts.join('');
  }

  clear(): void {
    this.partials.clear();
  }

  private sweep(): void {
    if (this.partials.size === 0) return;
    const cutoff = this.now() - this.staleMs;
    for (const [cid, partial] of this.partials) {
      if (partial.startedAt < cutoff) this.partials.delete(cid);
    }
  }
}
