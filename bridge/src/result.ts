import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { JsonValue } from './protocol.js';

/**
 * Character budget for one tool result. Claude Code caps MCP results at 25,000
 * tokens; dense JSON (paths, numbers, punctuation) tokenizes at roughly 2.5–3
 * chars per token, so 60,000 characters keeps a maximally shrunk result under
 * the cap with margin.
 */
export const RESULT_CHAR_BUDGET = 60_000;
const INLINE_ARRAY_CHARS = 120;
const INLINE_OBJECT_CHARS = 100;
const ARRAY_LIMITS = [500, 200, 100, 50, 20, 10, 5];
const STRING_LIMITS = [8000, 4000, 2000, 1000, 400];
const MAX_OBJECT_KEYS = 500;

function isPrimitive(value: JsonValue): value is string | number | boolean | null {
  return value === null || typeof value !== 'object';
}

/** Round-trips through JSON so toJSON/undefined/NaN are handled exactly like JSON.stringify would. */
export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  return text === undefined ? null : (JSON.parse(text) as JsonValue);
}

function format(value: JsonValue, depth: number): string {
  if (isPrimitive(value)) return JSON.stringify(value);
  const pad = ' '.repeat(depth + 1);
  const close = ' '.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isPrimitive)) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(',')}]`;
      if (inline.length <= INLINE_ARRAY_CHARS) return inline;
    }
    return `[\n${value.map((item) => pad + format(item, depth + 1)).join(',\n')}\n${close}]`;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  const entries = keys.map((key) => `${JSON.stringify(key)}:${format(value[key] as JsonValue, depth + 1)}`);
  if (keys.every((key) => isPrimitive(value[key] as JsonValue))) {
    const inline = `{${entries.join(',')}}`;
    if (inline.length <= INLINE_OBJECT_CHARS) return inline;
  }
  return `{\n${entries.map((entry) => pad + entry).join(',\n')}\n${close}}`;
}

/** Pretty-compact JSON: one space indent, short primitive arrays/objects inline. */
export function compactJson(value: unknown): string {
  return format(toJsonValue(value), 0);
}

function shrink(value: JsonValue, arrayLimit: number, stringLimit: number): JsonValue {
  if (typeof value === 'string') {
    return value.length > stringLimit ? `${value.slice(0, stringLimit)}…[+${value.length - stringLimit} chars]` : value;
  }
  if (isPrimitive(value)) return value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, arrayLimit).map((item) => shrink(item, arrayLimit, stringLimit));
    // The marker sits inside the array so a cut is visible wherever the array lives.
    if (value.length > arrayLimit) kept.push(`…[+${value.length - arrayLimit} more]`);
    return kept;
  }
  const out: Record<string, JsonValue> = {};
  const keys = Object.keys(value);
  let truncated = false;
  for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
    const child = value[key] as JsonValue;
    if (Array.isArray(child) && child.length > arrayLimit) truncated = true;
    out[key] = shrink(child, arrayLimit, stringLimit);
  }
  if (keys.length > MAX_OBJECT_KEYS) truncated = true;
  if (truncated) out.truncated = true;
  return out;
}

export interface ShrunkResult {
  text: string;
  truncated: boolean;
}

/** Serializes `value`, progressively cutting arrays and long strings until the text fits the budget. */
export function shrinkToBudget(value: unknown, budget: number = RESULT_CHAR_BUDGET): ShrunkResult {
  const json = toJsonValue(value);
  let text = format(json, 0);
  if (text.length <= budget) return { text, truncated: false };
  for (const arrayLimit of ARRAY_LIMITS) {
    for (const stringLimit of STRING_LIMITS) {
      text = format(shrink(json, arrayLimit, stringLimit), 0);
      if (text.length <= budget) return { text, truncated: true };
    }
  }
  return { text: `${text.slice(0, budget)}…[+${text.length - budget} chars, result truncated]`, truncated: true };
}

export interface BudgetedList<T> {
  kept: T[];
  truncated: boolean;
}

/**
 * Keeps the leading items whose pretty JSON fits `budget` characters. Cursored lists
 * (events, logs) go through this before their cursor is computed, so the cursor never
 * points past an item the caller did not receive. `depth` is the nesting level the
 * items will be printed at (2 for a list directly under the result object), so the
 * indentation the final layout adds is counted too.
 */
export function takeWithinBudget<T>(items: readonly T[], budget: number, depth = 2): BudgetedList<T> {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    used += format(toJsonValue(item), depth).length + depth + 3;
    if (used > budget && kept.length > 0) return { kept, truncated: true };
    kept.push(item);
  }
  return { kept, truncated: false };
}

export function textResult(value: unknown, isError = false): CallToolResult {
  const { text } = shrinkToBudget(value);
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

export function errorResult(code: string, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return textResult({ error: { code, message, ...extra } }, true);
}

export function imageResult(base64: string, mimeType: string, summary: Record<string, unknown>): CallToolResult {
  return {
    content: [
      { type: 'image', data: base64, mimeType },
      { type: 'text', text: compactJson(summary) },
    ],
  };
}

export function isCallToolResult(value: unknown): value is CallToolResult {
  if (typeof value !== 'object' || value === null) return false;
  const content = (value as { content?: unknown }).content;
  return Array.isArray(content) && content.every((item) => typeof item === 'object' && item !== null && typeof (item as { type?: unknown }).type === 'string');
}
