import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge, type Bridge } from '../../bridge/src/app.js';
import { loadConfig, readBootstrapVersion } from '../../bridge/src/config.js';
import { silentLogger } from '../../bridge/src/log.js';
import type { CaptureApi } from '../../bridge/src/tools.js';

const capture: CaptureApi = {
  captureStudio: async () => {
    throw Object.assign(new Error('no capture in tests'), { code: 'no_window' });
  },
};

describe('createBridge', () => {
  let home: string;
  let bridge: Bridge;

  beforeAll(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-app-test-'));
    bridge = await createBridge({ ...loadConfig({ STUDIO_LIVE_HOME: home }), port: 0 }, silentLogger, { capture });
  });

  afterAll(async () => {
    await bridge.close();
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('binds an ephemeral port, loads the real runtime bundle and serves /status without stdio', async () => {
    if (bridge.mode !== 'primary') throw new Error(`expected primary mode, got ${bridge.mode}`);
    expect(bridge.port).toBeGreaterThan(0);
    expect(bridge.port).not.toBe(47800);
    expect(Object.keys(bridge.bundle.current.modules)).toContain('runtime/init');
    const status = (await (await fetch(`http://127.0.0.1:${bridge.port}/status`)).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ name: 'studio-live', port: bridge.port, mode: 'primary', bootstrap: readBootstrapVersion(), active: null, sessions: [] });
    expect(bridge.skills.dir).toBe(path.join(home, 'skills'));
  });

  it('runs a second instance on the same port as a proxy that forwards tool calls to the primary', async () => {
    const proxy = await createBridge({ ...loadConfig({ STUDIO_LIVE_HOME: home }), port: bridge.port }, silentLogger, { capture });
    if (proxy.mode !== 'proxy') throw new Error(`expected proxy mode, got ${proxy.mode}`);
    expect(proxy.primary.pid).toBe(process.pid);
    const result = await proxy.executor.call('events', {});
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ error: { code: 'no_session' } });
    await proxy.close();
  });
});

describe('readBootstrapVersion', () => {
  it('reads the shipped bootstrap version and returns null when the file is absent', () => {
    expect(readBootstrapVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readBootstrapVersion(os.tmpdir())).toBeNull();
  });
});
