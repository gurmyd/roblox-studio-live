import { badRequest } from './errors.js';
import type { ActionDeps } from './types.js';

/**
 * Helpers shared by every action module: path prefixes, argument checks, response
 * coercion, and the poll loop that long-running Open Cloud operations (asset upload
 * and update, place publishing, the Instance API) all need.
 */
export const CLOUD_V2 = '/cloud/v2';
export const ASSETS_V1 = '/assets/v1';
/** How long an action waits for a long-running operation before handing back a re-poll handle. */
export const DEFAULT_WAIT_MS = 60_000;

export const enc = encodeURIComponent;

/** Rejects a missing required argument locally, before any request leaves the machine. */
export function need<T>(value: T | undefined, name: string, hint: string): T {
  if (value === undefined || value === null || (typeof value === 'string' && value === '')) throw badRequest(`${name} is required ${hint}`);
  return value;
}

/** Response bodies are JSON objects in the happy path; anything else is wrapped so spreading it is safe. */
export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body as Record<string, unknown>;
  return body === null || body === undefined ? {} : { body };
}

export function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Open Cloud durations are strings like "300s"; a whole number of seconds is always accepted. */
export function durationSeconds(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}

export function requireInteger(value: unknown, name: string, hint: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw badRequest(`${name} must be an integer ${hint}`);
  return value;
}

export interface PollOptions<T> {
  deps: ActionDeps;
  /** Absolute timestamp to stop polling at. */
  deadline: number;
  /** State already in hand (the create call's response, or a synthetic "not done yet"). */
  first: T;
  done(state: T): boolean;
  fetch(): Promise<T>;
  startMs?: number;
  stepMs?: number;
  maxMs?: number;
}

export interface PollResult<T> {
  state: T;
  /** True when the deadline passed while the operation was still running. */
  timedOut: boolean;
}

/**
 * Polls `fetch` with a linearly backing-off interval until `done` or the deadline.
 * Never sleeps past the deadline, so an action always answers within its own budget.
 */
export async function pollUntilDone<T>(options: PollOptions<T>): Promise<PollResult<T>> {
  const { deps, deadline, done, fetch } = options;
  let interval = options.startMs ?? 1000;
  const step = options.stepMs ?? 500;
  const max = options.maxMs ?? 3000;
  let state = options.first;
  while (!done(state)) {
    const now = deps.now();
    if (now >= deadline) return { state, timedOut: true };
    await deps.sleep(Math.min(interval, deadline - now));
    interval = Math.min(interval + step, max);
    state = await fetch();
  }
  return { state, timedOut: false };
}
