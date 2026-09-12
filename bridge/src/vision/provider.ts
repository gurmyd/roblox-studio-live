/**
 * Provider selection: which backend answers a `look`.
 *
 *   STUDIO_LIVE_VISION_PROVIDER = api        → always the Claude API through the SDK
 *                               = claude-cli → always the Claude Code CLI (`claude -p`)
 *                               = auto       → (default) the API when a credential resolves
 *                                              without a network call, else the CLI when a
 *                                              `claude` executable is on PATH, else an `auth`
 *                                              error that names both ways to fix it
 *
 * "A credential resolves" means what the SDK's own chain would find: ANTHROPIC_API_KEY or
 * ANTHROPIC_AUTH_TOKEN in the environment, or a profile the SDK's `loadConfig()` reads from
 * disk (`ant auth login`, ANTHROPIC_PROFILE, ANTHROPIC_CONFIG_DIR). Nothing here talks to the
 * network, so a wrong key is still only discovered by the first API call.
 *
 * The CLI is resolved with `where claude` (Windows) / `which claude` (elsewhere), with a
 * PATH scan as the fallback when that command itself is unavailable; a hit is cached for the
 * life of the process (and re-checked for existence on every use), a miss is re-probed on the
 * next call so installing Claude Code needs no bridge restart.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@anthropic-ai/sdk/lib/credentials';
import type { VisionLogLevel, VisionProvider, VisionProviderMode } from './types.js';

export const PROVIDER_ENV = 'STUDIO_LIVE_VISION_PROVIDER';
export const PROVIDER_MODES: readonly VisionProviderMode[] = ['api', 'claude-cli', 'auto'];
/** Name of the Claude Code executable looked up on PATH. */
export const CLI_NAME = 'claude';

export const AUTH_HINT =
  'set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment the bridge runs in, or run `ant auth login`; the credential is re-read on the next call, no bridge restart needed';
/** Appended to AUTH_HINT when neither an API credential nor the CLI is available. */
export const NO_PROVIDER_HINT = 'or install/log in to Claude Code so look can use it';

type Log = (level: VisionLogLevel, msg: string, data?: Record<string, unknown>) => void;

export interface ProviderSelection {
  provider: VisionProvider;
  mode: VisionProviderMode;
  /** `claude-cli`: resolved path of the executable. */
  cli?: string;
}

export interface ProviderUnavailable {
  provider: null;
  mode: VisionProviderMode | null;
  code: 'auth' | 'bad_request';
  message: string;
}

export type ProviderChoice = ProviderSelection | ProviderUnavailable;

/** Parses STUDIO_LIVE_VISION_PROVIDER; unset/empty → `auto`, anything else unknown → null. */
export function providerMode(): VisionProviderMode | null {
  const raw = process.env[PROVIDER_ENV]?.trim().toLowerCase() ?? '';
  if (raw === '') return 'auto';
  return (PROVIDER_MODES as readonly string[]).includes(raw) ? (raw as VisionProviderMode) : null;
}

/** ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, trimmed like the SDK's `readEnv` does. */
export function apiCredentialInEnv(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
}

/**
 * Whether `new Anthropic()` would find a credential: the env vars, or a profile / federation
 * config the SDK's `loadConfig()` resolves from disk. A malformed profile is treated as absent
 * (with a warning) so `auto` still has the CLI to fall back on.
 */
export async function apiCredentialAvailable(log?: Log): Promise<boolean> {
  if (apiCredentialInEnv()) return true;
  try {
    return (await loadConfig()) !== null;
  } catch (err) {
    log?.('warn', 'vision: the SDK profile could not be read; treating it as absent', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function windowsSystem32(name: string): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', name);
}

/** `where <name>` (Windows) / `which <name>`; the first line of output, or null. */
function whereWhich(name: string): Promise<string | null> {
  const win = process.platform === 'win32';
  const file = win ? windowsSystem32('where.exe') : 'which';
  return new Promise((resolve) => {
    try {
      execFile(file, [name], { windowsHide: true, timeout: 5_000, encoding: 'utf8' }, (err, stdout) => {
        if (err) return resolve(null);
        const first = String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0);
        resolve(first ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** What `where`/`which` do, in-process: the first PATH entry holding `<name><PATHEXT>` (Windows) or `<name>`. */
export async function scanPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const win = platform === 'win32';
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((dir) => dir.length > 0);
  const exts = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

let cachedCli: string | null = null;

/** Resolved path of the `claude` executable, or null when it is not on PATH. Cached once found. */
export async function findClaudeCli(): Promise<string | null> {
  if (cachedCli && (await isFile(cachedCli))) return cachedCli;
  cachedCli = null;
  const found = (await whereWhich(CLI_NAME)) ?? (await scanPath(CLI_NAME));
  if (found && (await isFile(found))) cachedCli = found;
  return cachedCli;
}

/** Forgets the cached executable path (tests, or after the user moves the install). */
export function resetProviderCache(): void {
  cachedCli = null;
}

export interface SelectDeps {
  log?: Log;
  /** Injected in tests; defaults to the env + profile probe. */
  hasApiCredential?: (log?: Log) => Promise<boolean>;
  /** Injected in tests; defaults to the cached PATH lookup. */
  findCli?: () => Promise<string | null>;
}

/** Applies the rules in the module comment. Never throws. */
export async function selectProvider(deps: SelectDeps = {}): Promise<ProviderChoice> {
  const mode = providerMode();
  if (mode === null) {
    return {
      provider: null,
      mode: null,
      code: 'bad_request',
      message: `${PROVIDER_ENV} must be one of ${PROVIDER_MODES.join(' | ')} (got '${process.env[PROVIDER_ENV]}')`,
    };
  }
  if (mode === 'api') return { provider: 'api', mode };
  const findCli = deps.findCli ?? findClaudeCli;
  if (mode === 'claude-cli') {
    const cli = await findCli();
    if (cli) return { provider: 'claude-cli', mode, cli };
    return {
      provider: null,
      mode,
      code: 'auth',
      message: `${PROVIDER_ENV}=claude-cli but no '${CLI_NAME}' executable is on the bridge's PATH: install Claude Code and log in (https://claude.com/claude-code), or unset the variable so look can use an API credential`,
    };
  }
  const hasApiCredential = deps.hasApiCredential ?? apiCredentialAvailable;
  if (await hasApiCredential(deps.log)) return { provider: 'api', mode };
  const cli = await findCli();
  if (cli) return { provider: 'claude-cli', mode, cli };
  return {
    provider: null,
    mode,
    code: 'auth',
    message: `no Claude API credential and no Claude Code CLI: ${AUTH_HINT}, ${NO_PROVIDER_HINT} (${PROVIDER_ENV} = auto | api | claude-cli)`,
  };
}

export interface CliCommand {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

function quoteForCmd(value: string): string {
  return /[\s"&|<>^()]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * How to spawn the resolved executable. A `.cmd` / `.bat` shim (an npm global install) cannot
 * be handed to `spawn` directly on Node ≥ 20 (CVE-2024-27980), so it runs through `cmd /d /s /c`
 * with the whole line quoted the way `shell: true` would; a `.ps1` goes through PowerShell; a
 * real executable (the native `claude.exe`) is spawned as is.
 */
export function cliCommand(exe: string, args: string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): CliCommand {
  if (platform !== 'win32') return { file: exe, args };
  const ext = path.win32.extname(exe).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const line = [quoteForCmd(exe), ...args.map(quoteForCmd)].join(' ');
    return { file: env.ComSpec ?? windowsSystem32('cmd.exe'), args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
  }
  if (ext === '.ps1') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', exe, ...args] };
  }
  return { file: exe, args };
}

/**
 * Ends a spawned CLI and, on Windows, everything it started (a `.cmd` shim's node child would
 * otherwise outlive `child.kill()`, which only reaches the direct child). Best effort.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn(windowsSystem32('taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      // taskkill missing, or it could not end the tree (non-zero exit): at least end the direct child.
      const plain = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          child.kill();
        } catch {
          // already gone
        }
      };
      killer.on('error', plain);
      killer.on('exit', (code) => {
        if (code !== 0) plain();
      });
      return;
    } catch {
      // fall through to a plain kill
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}
