import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bakePort, buildInstructions, formatInstallReport, installPlugin, mcpAddCommand, monitorCall } from '../../bridge/src/install.js';

let tmp: string;
let pluginsDir: string;
let sourcePath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-live-install-test-'));
  pluginsDir = path.join(tmp, 'Roblox', 'Plugins');
  sourcePath = path.join(tmp, 'StudioLive.rbxmx');
  await fs.writeFile(sourcePath, '<roblox version="4">v1</roblox>');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('installPlugin', () => {
  it('creates the plugins dir, copies the rbxmx and returns the five instructions', async () => {
    const result = await installPlugin({ pluginsDir, sourcePath });
    expect(result.pluginPath).toBe(path.join(pluginsDir, 'StudioLive.rbxmx'));
    expect(await fs.readFile(result.pluginPath, 'utf8')).toBe('<roblox version="4">v1</roblox>');
    expect(result.backupPath).toBeNull();
    expect(result.removedStale).toEqual([]);
    expect(path.isAbsolute(result.cliPath)).toBe(true);
    expect(result.cliPath.endsWith('cli.js')).toBe(true);
    expect(result.mcpAddCommand).toBe(`claude mcp add studio -- node "${result.cliPath}" serve`);
    expect(result.settingsAllow).toEqual(['mcp__studio__*', 'Monitor']);
    expect(result.monitorCall).toBe("Monitor({ ws: { url: 'ws://127.0.0.1:47800/events' }, persistent: true })");
    expect(result.instructions).toHaveLength(5);
    expect(result.instructions[0]).toMatch(/Restart Roblox Studio once/);
    expect(result.instructions[1]).toMatch(/Load User Plugins In Run Modes/);
    expect(result.instructions[2]).toContain(result.mcpAddCommand);
    expect(result.instructions[3]).toContain('"mcp__studio__*", "Monitor"');
    expect(result.instructions[4]).toContain(result.monitorCall);
  });

  it('backs up an existing plugin and removes a stale StudioLive.lua', async () => {
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.writeFile(path.join(pluginsDir, 'StudioLive.rbxmx'), 'old');
    await fs.writeFile(path.join(pluginsDir, 'StudioLive.lua'), 'stale loose script');
    const result = await installPlugin({ pluginsDir, sourcePath });
    expect(result.backupPath).toBe(path.join(pluginsDir, 'StudioLive.rbxmx.bak'));
    expect(await fs.readFile(result.backupPath!, 'utf8')).toBe('old');
    expect(await fs.readFile(result.pluginPath, 'utf8')).toBe('<roblox version="4">v1</roblox>');
    expect(result.removedStale).toEqual([path.join(pluginsDir, 'StudioLive.lua')]);
    await expect(fs.access(path.join(pluginsDir, 'StudioLive.lua'))).rejects.toThrow();
  });

  it('fails clearly when the packed plugin is missing', async () => {
    await expect(installPlugin({ pluginsDir, sourcePath: path.join(tmp, 'nope.rbxmx') })).rejects.toThrow(/npm run build/);
  });

  it('formats a report with numbered steps', async () => {
    const result = await installPlugin({ pluginsDir, sourcePath });
    const report = formatInstallReport(result);
    expect(report).toContain(`Installed ${result.pluginPath}`);
    expect(report).toMatch(/\n  1\. Restart Roblox Studio once/);
    expect(report).toMatch(/\n  5\. In a session, arm push/);
  });

  it('quotes the CLI path in the mcp add command', () => {
    expect(mcpAddCommand('C:\\with space\\cli.js')).toBe('claude mcp add studio -- node "C:\\with space\\cli.js" serve');
    expect(buildInstructions('x')[2]).toContain('claude mcp add studio -- node "x" serve');
  });

  it('bakes a non-default port into the installed plugin and every instruction', async () => {
    const packed = '<roblox version="4"><![CDATA[local VERSION, PROTO = "1.0.0", 1\nlocal DEFAULT_PORT = 47800\nlocal x = 47800\n]]></roblox>';
    await fs.writeFile(sourcePath, packed);
    const result = await installPlugin({ pluginsDir, sourcePath, port: 47801 });
    expect(result.port).toBe(47801);
    const installed = await fs.readFile(result.pluginPath, 'utf8');
    expect(installed).toContain('local DEFAULT_PORT = 47801\n');
    expect(installed).toContain('local x = 47800');
    expect(result.mcpAddCommand).toBe(`claude mcp add studio --env STUDIO_LIVE_PORT=47801 -- node "${result.cliPath}" serve`);
    expect(result.monitorCall).toBe(monitorCall(47801));
    expect(result.monitorCall).toContain('ws://127.0.0.1:47801/events');
    expect(formatInstallReport(result)).toMatch(/bridge port 47801/);

    // The default port leaves the packed file byte-for-byte alone.
    const plain = await installPlugin({ pluginsDir, sourcePath });
    expect(await fs.readFile(plain.pluginPath, 'utf8')).toBe(packed);
    expect(() => bakePort('no port line here', 1)).toThrow(/DEFAULT_PORT/);
  });
});
