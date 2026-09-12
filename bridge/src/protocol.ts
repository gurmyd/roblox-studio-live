/**
 * Wire types and guards for docs/protocol.md v1. Every frame is a JSON object
 * with `v: 1` and a `kind`. Guards check the fields the bridge relies on and
 * tolerate extra fields (unknown fields are ignored, never fatal).
 */

export const PROTO_VERSION = 1 as const;
export const L1_CHUNK_THRESHOLD_BYTES = 512 * 1024;
export const DEFAULT_DEADLINE_MS = 30_000;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Any parsed frame before narrowing. */
export type AnyFrame = { v?: number; kind: string; [key: string]: unknown };

export type Role = 'edit' | 'server' | 'client';

export type StudioInfo = {
  version?: string;
  placeId?: number;
  placeName?: string;
  dataModelName?: string;
  /** game.GameId; readable in the edit DM, reported by the hub in `hello.studio` and/or `hb`. */
  universeId?: number;
  /** game.CreatorType as its enum name (`User` | `Group`). */
  creatorType?: string;
  /** game.CreatorId. */
  creatorId?: number;
};

export type HelloFrame = {
  v: 1;
  kind: 'hello';
  proto: number;
  bootstrap: string;
  role: Role;
  session: string;
  studio?: StudioInfo;
  lastSeq?: number;
  targetId?: string;
  userId?: number;
  playerName?: string;
};

export type BundlePayload = {
  hash: string;
  entry: string;
  modules: Record<string, string>;
};

export type HelloAckFrame = {
  v: 1;
  kind: 'hello_ack';
  proto: 1;
  bridge: string;
  /** Random per bridge process; the hub drops state owned by a previous bridge when it changes (protocol Notes). */
  bridgeId: string;
  serverTime: number;
  ackUpto: number;
  bundle: BundlePayload | null;
};

export type BundleFrame = { v: 1; kind: 'bundle' } & BundlePayload;

export type ChunkFrame = {
  v: 1;
  kind: 'chunk';
  cid: string;
  i: number;
  n: number;
  data: string;
};

export type ReqFrame = {
  v: 1;
  kind: 'req';
  id: string;
  op: string;
  dm: string;
  deadline_ms: number;
  body: JsonObject;
};

/**
 * Executors may attach more fields (a `geometry_violation` carries the `geometry` report, `output`
 * the captured prints); the bridge passes every extra field through to the tool result.
 */
export type ResError = {
  code: string;
  message: string;
  stack?: string;
  output?: JsonValue[];
  [extra: string]: JsonValue | undefined;
};

/**
 * `run` geometry report (§4.1 / §4.2 `observe geometry`): overlapping part pairs and BaseParts parented
 * under BaseParts, as the runtime's `geometry.report` builds it. Lists are capped by the runtime (50 in a
 * run body); `totals` carries the uncapped counts.
 */
export type GeometryOverlap = { a: string; b: string; depth: number; aClass?: string; bClass?: string; approximate?: boolean; decor?: boolean };
export type GeometryNested = { path: string; parent: string; class?: string };
export type GeometryReport = {
  overlaps: GeometryOverlap[];
  nested: GeometryNested[];
  checked: number;
  sampled?: boolean;
  ms?: number;
  totals?: { overlaps: number; nested: number };
  /** Parts not under Workspace (nesting checked, overlaps impossible); present only when > 0. */
  outside?: number;
};

export type ResFrame = {
  v: 1;
  kind: 'res';
  id: string;
  ok: boolean;
  dm?: string;
  body?: JsonValue;
  error?: ResError;
};

export type ProgressFrame = {
  v: 1;
  kind: 'progress';
  id: string;
  note?: string;
  pct?: number;
};

export type CancelFrame = { v: 1; kind: 'cancel'; id: string };
export type CancelAllFrame = { v: 1; kind: 'cancel_all' };

/** `type` is one of log|error|assert|milestone|custom|playtest|peer|selection|job|controller|change in v1; unknown types pass through. */
export type EvFrame = {
  v: 1;
  kind: 'ev';
  seq: number;
  t: number;
  wall: number;
  src: string;
  type: string;
  [extra: string]: JsonValue | undefined;
};

export type AckFrame = { v: 1; kind: 'ack'; upto: number };

export type PeerInfo = {
  dm: string;
  connected: boolean;
  userId?: number;
  playerName?: string;
};

/**
 * `mode` is `play` | `run` | `multiplayer`; `players` is the client count of a multiplayer test. The hub's
 * `hb.playtest` also carries `startedAt` (its os.clock()) and `externallyStarted` (a test it did not start:
 * Studio's own button, or a multiplayer test launched elsewhere); both pass through untouched.
 */
export type PlaytestInfo = { running: boolean; mode?: string; starting?: boolean; players?: number; startedAt?: number; externallyStarted?: boolean };

export type HbFrame = {
  v: 1;
  kind: 'hb';
  seq: number;
  t: number;
  peers: PeerInfo[];
  playtest: PlaytestInfo;
  dropped: number;
  fps?: number;
  /** The resolved place name (MarketplaceService), once the hub knows it; supersedes `hello.studio.placeName`. */
  placeName?: string;
  /** Place identity the hub reads from the edit DM (game.GameId / CreatorType / CreatorId); optional, merged into the session's StudioInfo. */
  universeId?: number;
  creatorType?: string;
  creatorId?: number;
};

/** The `playtest` event states a hub emits (§2.5). */
export const PLAYTEST_EVENT_STATES: readonly string[] = ['starting', 'running', 'stopping', 'stopped', 'failed'];

/**
 * Playtest state implied by one `playtest` event, or null when the event says nothing about
 * whether a test is running (`stopping` keeps the previous state). Lets the bridge track the
 * flag between heartbeats so `/events` heartbeats are never more than one event behind.
 */
export function playtestInfoFromEvent(ev: EvFrame, previous: PlaytestInfo | null): PlaytestInfo | null {
  if (ev.type !== 'playtest' || typeof ev.state !== 'string') return null;
  const mode = typeof ev.mode === 'string' ? ev.mode : previous?.mode;
  const players = typeof ev.players === 'number' ? ev.players : previous?.players;
  const withMode = (info: PlaytestInfo): PlaytestInfo => {
    if (mode !== undefined) info.mode = mode;
    if (players !== undefined) info.players = players;
    return info;
  };
  switch (ev.state) {
    case 'starting':
      return withMode({ running: false, starting: true });
    case 'running':
      return withMode({ running: true, starting: false });
    case 'stopped':
    case 'failed':
      return { running: false, starting: false };
    default:
      return null;
  }
}

export type ErrorFrame = { v: 1; kind: 'error'; code: string; message: string };

export type BridgeToHubFrame =
  | HelloAckFrame
  | BundleFrame
  | ChunkFrame
  | ReqFrame
  | CancelFrame
  | CancelAllFrame
  | AckFrame
  | ErrorFrame;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Parses one text frame. Returns null when the text is not a JSON object with a string `kind`. */
export function parseFrame(text: string): AnyFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.kind !== 'string') return null;
  return parsed as AnyFrame;
}

export function isHelloFrame(f: AnyFrame): f is HelloFrame {
  return (
    f.kind === 'hello' &&
    isFiniteNumber(f.proto) &&
    typeof f.session === 'string' &&
    f.session.length > 0 &&
    typeof f.role === 'string' &&
    typeof f.bootstrap === 'string'
  );
}

export function isHelloAckFrame(f: AnyFrame): f is HelloAckFrame {
  return f.kind === 'hello_ack' && isFiniteNumber(f.proto) && typeof f.bridge === 'string' && isFiniteNumber(f.ackUpto);
}

export function isBundlePayload(value: unknown): value is BundlePayload {
  if (!isRecord(value) || typeof value.hash !== 'string' || typeof value.entry !== 'string' || !isRecord(value.modules)) {
    return false;
  }
  return Object.values(value.modules).every((source) => typeof source === 'string');
}

export function isBundleFrame(f: AnyFrame): f is BundleFrame {
  return f.kind === 'bundle' && isBundlePayload(f);
}

export function isChunkFrame(f: AnyFrame): f is ChunkFrame {
  return (
    f.kind === 'chunk' &&
    typeof f.cid === 'string' &&
    Number.isInteger(f.i) &&
    Number.isInteger(f.n) &&
    (f.n as number) > 0 &&
    (f.i as number) >= 0 &&
    (f.i as number) < (f.n as number) &&
    typeof f.data === 'string'
  );
}

export function isReqFrame(f: AnyFrame): f is ReqFrame {
  return f.kind === 'req' && typeof f.id === 'string' && typeof f.op === 'string' && isRecord(f.body);
}

export function isResError(value: unknown): value is ResError {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string';
}

export function isResFrame(f: AnyFrame): f is ResFrame {
  if (f.kind !== 'res' || typeof f.id !== 'string' || typeof f.ok !== 'boolean') return false;
  return f.ok || isResError(f.error);
}

export function isProgressFrame(f: AnyFrame): f is ProgressFrame {
  return f.kind === 'progress' && typeof f.id === 'string';
}

export function isCancelFrame(f: AnyFrame): f is CancelFrame {
  return f.kind === 'cancel' && typeof f.id === 'string';
}

export function isCancelAllFrame(f: AnyFrame): f is CancelAllFrame {
  return f.kind === 'cancel_all';
}

export function isEvFrame(f: AnyFrame): f is EvFrame {
  return f.kind === 'ev' && isFiniteNumber(f.seq) && typeof f.type === 'string' && typeof f.src === 'string';
}

export function isAckFrame(f: AnyFrame): f is AckFrame {
  return f.kind === 'ack' && isFiniteNumber(f.upto);
}

export function isPeerInfo(value: unknown): value is PeerInfo {
  return isRecord(value) && typeof value.dm === 'string' && typeof value.connected === 'boolean';
}

export function isHbFrame(f: AnyFrame): f is HbFrame {
  return (
    f.kind === 'hb' &&
    isFiniteNumber(f.seq) &&
    Array.isArray(f.peers) &&
    f.peers.every(isPeerInfo) &&
    isRecord(f.playtest) &&
    typeof f.playtest.running === 'boolean'
  );
}

export function isErrorFrame(f: AnyFrame): f is ErrorFrame {
  return f.kind === 'error' && typeof f.code === 'string' && typeof f.message === 'string';
}

/** `edit` | `server` | `client` | `client:N` (N ≥ 1). */
export const DM_PATTERN = /^(edit|server|client(:[1-9]\d*)?)$/;
