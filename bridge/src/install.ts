/**
 * Installs the packed bootstrap plugin (dist/StudioLive.rbxmx) into Studio's local plugins folder
 * and produces the follow-up instructions. Studio loads plugin files only at start, so the install
 * requires exactly one Studio restart; the runtime itself is pushed by the bridge on every connect.
 * The bridge port is baked into the installed plugin: the bootstrap reads no settings.
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from './config.js';

export const PLUGIN_FILE_NAME = 'StudioLive.rbxmx';
export const STALE_PLUGIN_FILE_NAME = 'StudioLive.lua';
export const MCP_SERVER_NAME = 'studio';
export const RECOMMENDED_PERMISSIONS = ['mcp__studio__*', 'Monitor'] as const;
/** The bootstrap's port line; pack-plugin keeps it on its own line so it can be rewritten here. */
const PORT_LINE = /^local DEFAULT_PORT = \d+/m;

export interface InstallOptions {
  /** Studio's local plugins folder (default %LOCALAPPDATA%\Roblox\Plugins). */
  pluginsDir?: string;
  /** The packed plugin to install (default <package>/dist/StudioLive.rbxmx). */
  sourcePath?: string;
  /** Bridge port to bake into the plugin (default 47800 / STUDIO_LIVE_PORT as loaded by the CLI). */
  port?: number;
}

export interface InstallResult {
  /** Where the plugin now lives. */
  pluginPath: string;
  /** Previous plugin file, preserved as *.bak (null on a fresh install). */
  backupPath: string | null;
  /** Legacy loose-script plugin files that were removed so the plugin does not load twice. */
  removedStale: string[];
  /** Absolute path of the bridge CLI entry point to register with the MCP client. */
  cliPath: string;
  /** Port the installed plugin dials. */
  port: number;
  mcpAddCommand: string;
  settingsAllow: readonly string[];
  monitorCall: string;
  /** Human-readable, numbered follow-up steps. */
  instructions: string[];
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function defaultPluginsDir(): string {
  const localAppData = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Roblox', 'Plugins');
}

/** Nearest ancestor of this module that holds a package.json (works from dist/ and from source). */
export function packageRoot(): string {
  let dir = moduleDir;
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`could not locate package.json above ${moduleDir}`);
    dir = parent;
  }
}

/** Absolute path of the compiled CLI: next to this module in dist/bridge, or dist/bridge/cli.js when running from source. */
export function cliEntryPath(): string {
  const sibling = path.join(moduleDir, 'cli.js');
  if (existsSync(sibling)) return sibling;
  return path.join(packageRoot(), 'dist', 'bridge', 'cli.js');
}

export function eventsWsUrl(port: number = DEFAULT_PORT): string {
  return `ws://127.0.0.1:${port}/events`;
}

export function mcpAddCommand(cliPath: string, port: number = DEFAULT_PORT): string {
  const env = port === DEFAULT_PORT ? '' : `--env STUDIO_LIVE_PORT=${port} `;
  return `claude mcp add ${MCP_SERVER_NAME} ${env}-- node "${cliPath}" serve`;
}

export function monitorCall(port: number = DEFAULT_PORT): string {
  return `Monitor({ ws: { url: '${eventsWsUrl(port)}' }, persistent: true })`;
}

/** Rewrites the bootstrap's DEFAULT_PORT inside the packed plugin text (CDATA keeps the Luau verbatim). */
export function bakePort(pluginText: string, port: number): string {
  if (!PORT_LINE.test(pluginText)) throw new Error('packed plugin has no "local DEFAULT_PORT = <n>" line; rebuild with "npm run build"');
  return pluginText.replace(PORT_LINE, `local DEFAULT_PORT = ${port}`);
}

export function buildInstructions(cliPath: string, port: number = DEFAULT_PORT): string[] {
  return [
    'Restart Roblox Studio once. The edit DataModel loads plugin files only at start; after this one restart, ' +
      'runtime updates arrive from the bridge on every connect and never need another restart.',
    "In Studio: File > Studio Settings > Studio > 'Load User Plugins In Run Modes' must be ON, otherwise " +
      'playtests have no server/client peers (it is already on when Studio reports playtest peers).',
    `Register the MCP server with Claude Code:\n    ${mcpAddCommand(cliPath, port)}`,
    'Recommended .claude/settings.json entries so tool calls and the push monitor run without prompts:\n' +
      `    { "permissions": { "allow": [${RECOMMENDED_PERMISSIONS.map((p) => `"${p}"`).join(', ')}] } }`,
    `In a session, arm push events once:\n    ${monitorCall(port)}\n` +
      '    If Monitor is unavailable, poll with the events tool instead (events({ since })).',
  ];
}

export async function installPlugin(options: InstallOptions = {}): Promise<InstallResult> {
  const pluginsDir = options.pluginsDir ?? defaultPluginsDir();
  const sourcePath = options.sourcePath ?? path.join(packageRoot(), 'dist', PLUGIN_FILE_NAME);
  const port = options.port ?? DEFAULT_PORT;
  if (!existsSync(sourcePath)) {
    throw new Error(`${sourcePath} not found; run "npm run build" first (scripts/pack-plugin.mjs emits it from plugin/bootstrap.luau)`);
  }

  await fs.mkdir(pluginsDir, { recursive: true });
  const pluginPath = path.join(pluginsDir, PLUGIN_FILE_NAME);

  let backupPath: string | null = null;
  if (existsSync(pluginPath)) {
    backupPath = `${pluginPath}.bak`;
    await fs.copyFile(pluginPath, backupPath);
  }
  const packed = await fs.readFile(sourcePath, 'utf8');
  await fs.writeFile(pluginPath, port === DEFAULT_PORT ? packed : bakePort(packed, port), 'utf8');

  const removedStale: string[] = [];
  const stalePath = path.join(pluginsDir, STALE_PLUGIN_FILE_NAME);
  if (existsSync(stalePath)) {
    await fs.unlink(stalePath);
    removedStale.push(stalePath);
  }

  const cliPath = cliEntryPath();
  return {
    pluginPath,
    backupPath,
    removedStale,
    cliPath,
    port,
    mcpAddCommand: mcpAddCommand(cliPath, port),
    settingsAllow: RECOMMENDED_PERMISSIONS,
    monitorCall: monitorCall(port),
    instructions: buildInstructions(cliPath, port),
  };
}

/** Plain-text report for the CLI (stderr-safe: contains no MCP framing). */
export function formatInstallReport(result: InstallResult): string {
  const lines = [`Installed ${result.pluginPath} (bridge port ${result.port})`];
  if (result.backupPath) lines.push(`Previous plugin backed up to ${result.backupPath}`);
  for (const stale of result.removedStale) lines.push(`Removed stale ${stale}`);
  lines.push('', 'Next steps:');
  result.instructions.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
  return lines.join('\n');
}
