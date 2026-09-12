/**
 * Result rendering: JSON text capped at 20 KB (arrays, long strings and wide objects are
 * cut first, with a `truncated: true` flag; the output is always valid JSON), plus secret
 * masking for anything that leaves the module (tool results and log lines).
 */
export const RESULT_BYTE_BUDGET = 20 * 1024;
export const SECRET_MASK = 'sk…';
/** Marker key added to an object whose entries were cut. */
export const MORE_KEYS_MARKER = '…';
const SHRINK_STEPS: ReadonlyArray<readonly [arrayLimit: number, stringLimit: number, keyLimit: number]> = [
  [200, 4000, 500],
  [100, 2000, 200],
  [50, 1000, 100],
  [20, 500, 50],
  [10, 200, 20],
  [5, 100, 10],
];
const LAST_RESORT_NOTE = 'result exceeds the size budget even after cutting arrays, strings and object keys; preview is the head of the JSON text';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function toJson(value: unknown): Json {
  const text = JSON.stringify(value);
  return text === undefined ? null : (JSON.parse(text) as Json);
}

function shrink(value: Json, arrayLimit: number, stringLimit: number, keyLimit: number): Json {
  if (typeof value === 'string') {
    return value.length > stringLimit ? `${value.slice(0, stringLimit)}…[+${value.length - stringLimit} chars]` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const kept: Json[] = value.slice(0, arrayLimit).map((item) => shrink(item, arrayLimit, stringLimit, keyLimit));
    if (value.length > arrayLimit) kept.push(`…[+${value.length - arrayLimit} more]`);
    return kept;
  }
  // Wide maps (e.g. an inventory keyed by item id) would otherwise never get smaller.
  const entries = Object.entries(value);
  const out: { [key: string]: Json } = {};
  for (const [key, child] of entries.slice(0, keyLimit)) out[key] = shrink(child, arrayLimit, stringLimit, keyLimit);
  if (entries.length > keyLimit) out[MORE_KEYS_MARKER] = `+${entries.length - keyLimit} more keys`;
  return out;
}

function render(value: Json): string {
  return JSON.stringify(value, null, 1);
}

export interface Rendered {
  text: string;
  truncated: boolean;
}

/**
 * Serializes `value`, cutting arrays/strings/object keys until the text fits `budget` bytes.
 * The text is always parseable JSON: when even the tightest cut does not fit (deep nesting,
 * huge numbers of numeric leaves) the result is `{ truncated: true, note, preview }` with the
 * head of the JSON text as a string — never a JSON document sliced mid-structure.
 */
export function renderResult(value: unknown, budget: number = RESULT_BYTE_BUDGET): Rendered {
  const json = toJson(value);
  let text = render(json);
  if (Buffer.byteLength(text) <= budget) return { text, truncated: false };
  const flagged = (shrunk: Json): Json => (shrunk !== null && typeof shrunk === 'object' && !Array.isArray(shrunk) ? { ...shrunk, truncated: true } : shrunk);
  for (const [arrayLimit, stringLimit, keyLimit] of SHRINK_STEPS) {
    text = render(flagged(shrink(json, arrayLimit, stringLimit, keyLimit)));
    if (Buffer.byteLength(text) <= budget) return { text, truncated: true };
  }
  // Last resort: wrap the head of the (tightest) text in a valid JSON envelope that fits.
  let keep = Math.max(0, budget - 256);
  for (;;) {
    const out = render({ truncated: true, note: LAST_RESORT_NOTE, preview: text.slice(0, keep) });
    const bytes = Buffer.byteLength(out);
    if (bytes <= budget || keep === 0) return { text: out, truncated: true };
    // Every dropped character removes at least one byte, so this converges in a step or two.
    keep = Math.max(0, keep - (bytes - budget));
  }
}

/** Replaces every occurrence of `secret` (raw and URL-encoded) in `text`. */
export function maskSecret(text: string, secret: string | null | undefined): string {
  if (!secret) return text;
  let out = text.split(secret).join(SECRET_MASK);
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) out = out.split(encoded).join(SECRET_MASK);
  return out;
}

/** Recursively masks `secret` inside strings of any JSON-ish value (log metadata). */
export function scrubSecret(value: unknown, secret: string | null | undefined): unknown {
  if (!secret) return value;
  if (typeof value === 'string') return maskSecret(value, secret);
  if (value instanceof Error) return { name: value.name, message: maskSecret(value.message, secret) };
  if (Array.isArray(value)) return value.map((item) => scrubSecret(item, secret));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) out[key] = scrubSecret(child, secret);
    return out;
  }
  return value;
}
