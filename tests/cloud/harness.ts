import { expect } from 'vitest';
import type { CloudContext, CloudIds, ToolText } from '../../bridge/src/cloud/index.js';

/**
 * Shared fixtures for the cloud tests. `cloud.test.ts` predates this file and keeps its own
 * copies; newer suites import from here so the ids and helpers cannot drift between them.
 */
export const KEY = 'TESTKEY-abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFGHIJ';
export const OTHER_KEY = 'OTHERKEY-zyxwvutsrqponmlkjihgfedcba9876543210';
export const STUDIO: CloudIds = { universeId: 111, placeId: 222, creatorType: 'Group', creatorId: 333, placeName: 'PIRATES' };

export interface LogLine {
  level: string;
  msg: string;
  data?: Record<string, unknown>;
}

export function makeCtx(home: string, ids: CloudIds | null = STUDIO): { ctx: CloudContext; logs: LogLine[] } {
  const logs: LogLine[] = [];
  return {
    ctx: {
      home,
      ids: () => ids,
      log: (level, msg, data) => {
        logs.push({ level, msg, data });
      },
    },
    logs,
  };
}

export function parse(result: ToolText): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

export function errorOf(result: ToolText): { code: string; message: string; [k: string]: unknown } {
  expect(result.isError).toBe(true);
  return parse(result).error as { code: string; message: string };
}
