import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_HINT,
  NO_PROVIDER_HINT,
  PROVIDER_ENV,
  apiCredentialAvailable,
  apiCredentialInEnv,
  cliCommand,
  findClaudeCli,
  providerMode,
  resetProviderCache,
  scanPath,
  selectProvider,
} from '../../bridge/src/vision/provider.js';
import { installFakeClaude, samePath, type FakeClaude, type LogLine } from './helpers.js';

/** Everything the selection reads; cleared before each test and restored after. */
const ENV_KEYS = [
  'STUDIO_LIVE_VISION_PROVIDER',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_CONFIG_DIR',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
] as const;

const originalPath = process.env.PATH;
let saved: Record<string, string | undefined> = {};
let fake: FakeClaude;
let emptyDir: string;
let configDir: string;

function pathWith(dir: string): void {
  process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ''}`;
}

/** Only `dir` on PATH: no claude anywhere (where.exe is invoked by absolute path, `which` falls back to the scan). */
function pathOnly(dir: string): void {
  process.env.PATH = dir;
}

function writeProfile(body: string): void {
  mkdirSync(path.join(configDir, 'configs'), { recursive: true });
  writeFileSync(path.join(configDir, 'configs', 'default.json'), body);
}

beforeAll(() => {
  fake = installFakeClaude();
  emptyDir = mkdtempSync(path.join(os.tmpdir(), 'studio-live-empty-'));
  configDir = mkdtempSync(path.join(os.tmpdir(), 'studio-live-anthropic-cfg-'));
});

afterAll(() => {
  fake.cleanup();
  rmSync(emptyDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  // An empty SDK config dir: no profile resolves unless a test writes one.
  rmSync(path.join(configDir, 'configs'), { recursive: true, force: true });
  process.env.ANTHROPIC_CONFIG_DIR = configDir;
  resetProviderCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  process.env.PATH = originalPath;
  resetProviderCache();
});

describe('providerMode', () => {
  it('defaults to auto and accepts the three modes case-insensitively', () => {
    expect(providerMode()).toBe('auto');
    process.env[PROVIDER_ENV] = '';
    expect(providerMode()).toBe('auto');
    process.env[PROVIDER_ENV] = 'API';
    expect(providerMode()).toBe('api');
    process.env[PROVIDER_ENV] = ' claude-cli ';
    expect(providerMode()).toBe('claude-cli');
    process.env[PROVIDER_ENV] = 'auto';
    expect(providerMode()).toBe('auto');
    process.env[PROVIDER_ENV] = 'cli';
    expect(providerMode()).toBeNull();
  });
});

describe('API credential probe', () => {
  it('sees ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, ignoring blanks', () => {
    expect(apiCredentialInEnv()).toBe(false);
    process.env.ANTHROPIC_API_KEY = '   ';
    expect(apiCredentialInEnv()).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(apiCredentialInEnv()).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = 'oauth-test';
    expect(apiCredentialInEnv()).toBe(true);
  });

  it('counts an SDK profile on disk as a credential and a broken one as none (with a warning)', async () => {
    expect(await apiCredentialAvailable()).toBe(false);
    writeProfile(JSON.stringify({ authentication: { type: 'user_oauth' } }));
    expect(await apiCredentialAvailable()).toBe(true);
    writeProfile('{not json');
    const logs: LogLine[] = [];
    expect(await apiCredentialAvailable((level, msg, data) => logs.push({ level, msg, data }))).toBe(false);
    expect(logs).toEqual([expect.objectContaining({ level: 'warn', msg: expect.stringContaining('profile') })]);
  });
});

describe('claude executable lookup', () => {
  it('finds the shim first on PATH, caches it, and forgets it on reset', async () => {
    pathWith(fake.dir);
    const found = await findClaudeCli();
    expect(samePath(found, fake.exe)).toBe(true);
    pathOnly(emptyDir);
    expect(samePath(await findClaudeCli(), fake.exe)).toBe(true); // cached while the file exists
    resetProviderCache();
    expect(await findClaudeCli()).toBeNull();
    pathWith(fake.dir);
    expect(samePath(await findClaudeCli(), fake.exe)).toBe(true); // a miss is re-probed on the next call
  });

  it('scanPath mirrors where/which: PATHEXT on Windows, the bare name elsewhere', async () => {
    const env = { PATH: `${emptyDir}${path.delimiter}${fake.dir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(samePath(await scanPath('claude', env, process.platform), fake.exe)).toBe(true);
    expect(await scanPath('claude', { PATH: emptyDir, PATHEXT: env.PATHEXT }, process.platform)).toBeNull();
    expect(await scanPath('claude', { PATH: '' }, process.platform)).toBeNull();
  });
});

describe('selectProvider', () => {
  it('forced api: the API, whatever else is around', async () => {
    process.env[PROVIDER_ENV] = 'api';
    pathOnly(emptyDir);
    expect(await selectProvider()).toEqual({ provider: 'api', mode: 'api' });
    pathWith(fake.dir);
    expect(await selectProvider()).toEqual({ provider: 'api', mode: 'api' });
  });

  it('forced claude-cli: the CLI when it is on PATH, an auth error naming the install otherwise', async () => {
    process.env[PROVIDER_ENV] = 'claude-cli';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'; // ignored: the user asked for the CLI
    pathWith(fake.dir);
    const chosen = await selectProvider();
    expect(chosen.provider).toBe('claude-cli');
    expect(chosen.mode).toBe('claude-cli');
    expect(samePath((chosen as { cli?: string }).cli, fake.exe)).toBe(true);

    resetProviderCache();
    pathOnly(emptyDir);
    const missing = await selectProvider();
    expect(missing).toMatchObject({ provider: null, mode: 'claude-cli', code: 'auth' });
    expect((missing as { message: string }).message).toContain('claude-cli');
    expect((missing as { message: string }).message).toContain('install Claude Code');
  });

  it('rejects an unknown mode with bad_request instead of guessing', async () => {
    process.env[PROVIDER_ENV] = 'cli';
    const bad = await selectProvider();
    expect(bad).toMatchObject({ provider: null, mode: null, code: 'bad_request' });
    expect((bad as { message: string }).message).toContain(PROVIDER_ENV);
    expect((bad as { message: string }).message).toContain("'cli'");
  });

  it('auto with a credential in the environment: the API, even with claude on PATH', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    pathWith(fake.dir);
    expect(await selectProvider()).toEqual({ provider: 'api', mode: 'auto' });
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = 'oauth-test';
    expect(await selectProvider()).toEqual({ provider: 'api', mode: 'auto' });
  });

  it('auto with an SDK profile on disk: the API', async () => {
    writeProfile(JSON.stringify({ authentication: { type: 'user_oauth' } }));
    pathWith(fake.dir);
    expect(await selectProvider()).toEqual({ provider: 'api', mode: 'auto' });
  });

  it('auto without a credential but with claude on PATH: the CLI', async () => {
    pathWith(fake.dir);
    const chosen = await selectProvider();
    expect(chosen.provider).toBe('claude-cli');
    expect(chosen.mode).toBe('auto');
    expect(samePath((chosen as { cli?: string }).cli, fake.exe)).toBe(true);
  });

  it('auto with neither: the auth error, extended with the Claude Code option', async () => {
    pathOnly(emptyDir);
    const none = await selectProvider();
    expect(none).toMatchObject({ provider: null, mode: 'auto', code: 'auth' });
    const message = (none as { message: string }).message;
    expect(message).toContain(AUTH_HINT);
    expect(message).toContain(NO_PROVIDER_HINT);
    expect(message).toContain('install/log in to Claude Code');
    expect(message).toContain(PROVIDER_ENV);
  });

  it('takes injected probes (no disk, no PATH)', async () => {
    expect(await selectProvider({ hasApiCredential: async () => true, findCli: async () => null })).toEqual({ provider: 'api', mode: 'auto' });
    expect(await selectProvider({ hasApiCredential: async () => false, findCli: async () => '/opt/claude' })).toEqual({ provider: 'claude-cli', mode: 'auto', cli: '/opt/claude' });
    expect(await selectProvider({ hasApiCredential: async () => false, findCli: async () => null })).toMatchObject({ provider: null, code: 'auth' });
  });
});

describe('cliCommand', () => {
  const args = ['-p', '--model', 'haiku', '--output-format', 'json', '--allowedTools', 'Read', '--strict-mcp-config'];

  it('spawns a real executable directly on every platform', () => {
    expect(cliCommand('C:\\Users\\me\\.local\\bin\\claude.exe', args, 'win32')).toEqual({ file: 'C:\\Users\\me\\.local\\bin\\claude.exe', args });
    expect(cliCommand('/home/me/.local/bin/claude', args, 'linux')).toEqual({ file: '/home/me/.local/bin/claude', args });
    expect(cliCommand('/usr/local/bin/claude.cmd', args, 'darwin')).toEqual({ file: '/usr/local/bin/claude.cmd', args });
  });

  it('runs a .cmd / .bat shim through cmd /d /s /c with the line quoted, verbatim arguments on', () => {
    const cmd = cliCommand('C:\\Program Files\\nodejs\\claude.cmd', args, 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
    expect(cmd).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\claude.cmd" -p --model haiku --output-format json --allowedTools Read --strict-mcp-config"'],
      windowsVerbatimArguments: true,
    });
    const bat = cliCommand('C:\\tools\\claude.BAT', ['-p'], 'win32', {});
    expect(bat.file.toLowerCase()).toContain('cmd.exe');
    expect(bat.args).toEqual(['/d', '/s', '/c', '"C:\\tools\\claude.BAT -p"']);
  });

  it('runs a .ps1 shim through PowerShell with the execution policy bypassed', () => {
    expect(cliCommand('C:\\tools\\claude.ps1', ['-p', '--model', 'sonnet'], 'win32')).toEqual({
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\tools\\claude.ps1', '-p', '--model', 'sonnet'],
    });
  });
});
