import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaptureClient, CaptureError, CaptureWorker } from '../../bridge/src/capture/index.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-worker.mjs');

let outDir: string;
let client: CaptureClient;

beforeEach(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-live-capture-test-'));
  const worker = new CaptureWorker({ command: process.execPath, args: [FAKE], timeoutMs: 3_000, log: () => undefined });
  client = new CaptureClient(worker, { outDir, maxFrames: 5, log: () => undefined });
});

afterEach(async () => {
  await client.shutdown();
  await fs.rm(outDir, { recursive: true, force: true });
});

describe('CaptureClient.listStudioWindows', () => {
  it('flattens the worker rect into the StudioWindow shape', async () => {
    const windows = await client.listStudioWindows();
    expect(windows).toEqual([
      { hwnd: '134302', pid: 38556, title: 'PIRATES - Roblox Studio', x: 1713, y: 0, width: 1734, height: 1399, minimized: false, foreground: false },
      { hwnd: '9001', pid: 38556, title: 'Explorer - Roblox Studio', x: 0, y: 0, width: 300, height: 600, minimized: true, foreground: false },
    ]);
  });
});

describe('CaptureClient.captureStudio', () => {
  it('writes a frame into outDir, returns bytes/base64 and forwards defaults to the worker', async () => {
    const result = await client.captureStudio();
    expect(result.path.startsWith(outDir)).toBe(true);
    expect(path.basename(result.path)).toMatch(/^frame-\d{8}T\d{9}-0001\.jpg$/);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.windowTitle).toBe('PIRATES - Roblox Studio');
    expect(result.hwnd).toBe('134302');
    expect(result.captured_ms).toBe(41.5);
    expect(result.width).toBe(1024);
    expect(result.sourceWidth).toBe(1734);
    expect(result.sourceHeight).toBe(1399);
    expect(result.scale).toBe(1.693);
    const onDisk = await fs.readFile(result.path);
    expect(result.bytes).toBe(onDisk.length);
    expect(Buffer.from(result.base64, 'base64').equals(onDisk)).toBe(true);
  });

  it('sends every option through and names png frames .png', async () => {
    const result = await client.captureStudio({
      hwnd: '4242',
      titleMatch: 'PIRATES',
      maxWidth: 512,
      format: 'png',
      quality: 90,
      region: { x: 10, y: 20, w: 300, h: 200 },
      restore: false,
    });
    expect(result.mimeType).toBe('image/png');
    expect(result.path.endsWith('.png')).toBe(true);
    expect(result.hwnd).toBe('4242');
    expect(result.width).toBe(512);
  });

  it('raises no_window / minimized / capture_failed with the worker message', async () => {
    await expect(client.captureStudio({ titleMatch: 'nomatch' })).rejects.toMatchObject({ code: 'no_window', message: expect.stringMatching(/nomatch/) });
    await expect(client.captureStudio({ hwnd: '777', restore: false })).rejects.toMatchObject({ code: 'minimized' });
    await expect(client.captureStudio({ format: 'png', region: { x: 9000, y: 0, w: 1, h: 1 } })).rejects.toMatchObject({ code: 'capture_failed' });
  });

  it('rejects a non-numeric hwnd and an unknown format before talking to the worker', async () => {
    await expect(client.captureStudio({ hwnd: 'abc' })).rejects.toMatchObject({ code: 'no_window' });
    await expect(client.captureStudio({ format: 'gif' as unknown as 'png' })).rejects.toMatchObject({ code: 'capture_failed' });
    expect(client.worker.pid).toBeUndefined();
  });

  it('maps unknown worker codes and malformed replies to capture_failed', async () => {
    const unknownCode = await client.captureStudio({ titleMatch: 'weird-code' }).catch((e: unknown) => e);
    expect(unknownCode).toBeInstanceOf(CaptureError);
    expect(unknownCode).toMatchObject({ code: 'capture_failed', message: 'a code the client does not know' });

    const malformed = await client.captureStudio({ titleMatch: 'malformed' }).catch((e: unknown) => e);
    expect(malformed).toBeInstanceOf(CaptureError);
    expect(malformed).toMatchObject({ code: 'capture_failed', message: expect.stringMatching(/malformed 'capture' reply.*path/) });
  });

  it('keeps only the newest maxFrames frames', async () => {
    for (let i = 0; i < 8; i += 1) await client.captureStudio();
    const names = (await fs.readdir(outDir)).filter((n) => n.startsWith('frame-')).sort();
    expect(names).toHaveLength(5);
    expect(names[names.length - 1]).toMatch(/-0008\.jpg$/);
    expect(names[0]).toMatch(/-0004\.jpg$/);
  });

  it('honours a per-call outDir', async () => {
    const other = path.join(outDir, 'elsewhere');
    const result = await client.captureStudio({ outDir: other });
    expect(path.dirname(result.path)).toBe(other);
  });
});

describe('CaptureClient.restoreWindow', () => {
  it('resolves on ok and surfaces no_window', async () => {
    await expect(client.restoreWindow('134302')).resolves.toBeUndefined();
    await expect(client.restoreWindow('1')).rejects.toMatchObject({ code: 'no_window' });
    await expect(client.restoreWindow('x')).rejects.toMatchObject({ code: 'no_window' });
  });
});
