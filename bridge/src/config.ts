import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError } from './errors.js';
import { parseLogLevel, type LogLevel } from './log.js';

export const DEFAULT_PORT = 47800;

/**
 * What an edit-DM `run` does about overlapping / nested parts its program created (protocol §4.1):
 * `warn` reports them in the result, `reject` rolls the program back with `geometry_violation`,
 * `off` skips the check. The bridge default (STUDIO_LIVE_GEOMETRY_POLICY) applies when the tool
 * argument is absent.
 */
export const GEOMETRY_POLICIES = ['warn', 'reject', 'off'] as const;
export type GeometryPolicy = (typeof GEOMETRY_POLICIES)[number];
export const DEFAULT_GEOMETRY_POLICY: GeometryPolicy = 'warn';

export function parseGeometryPolicy(raw: string | undefined): GeometryPolicy {
  if (raw === undefined || raw === '') return DEFAULT_GEOMETRY_POLICY;
  const policy = raw.trim().toLowerCase();
  if ((GEOMETRY_POLICIES as readonly string[]).includes(policy)) return policy as GeometryPolicy;
  throw new BridgeError('bad_config', `STUDIO_LIVE_GEOMETRY_POLICY must be one of ${GEOMETRY_POLICIES.join(' | ')}, got "${raw}"`);
}

/**
 * Package root: the nearest ancestor of this module that holds a package.json.
 * Works for bridge/src (tsx) and for any dist/ layout tsc emits.
 */
export function findPackageRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new BridgeError('bad_config', `no package.json above ${from}`);
    dir = parent;
  }
}

export const PACKAGE_ROOT = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

export interface BridgeConfig {
  port: number;
  /** ~/.studio-live by default; holds skills/ and capture output. */
  home: string;
  skillsDir: string;
  /** <home>/persist: one `<placeId>.json` per place holding the persisted playtest controllers. */
  persistDir: string;
  /** skills/builtin inside the package: read-only skills shipped with the bridge. */
  builtinSkillsDir: string;
  /** plugin/runtime inside the package. */
  runtimeDir: string;
  packageRoot: string;
  dev: boolean;
  logLevel: LogLevel;
  /** Default `geometry_policy` for edit-DM runs (STUDIO_LIVE_GEOMETRY_POLICY: warn | reject | off, default warn). */
  geometryPolicy: GeometryPolicy;
  version: string;
  /** Version literal of the bootstrap this package ships (plugin/bootstrap.luau); null when unreadable. */
  bootstrapVersion: string | null;
}

const BOOTSTRAP_VERSION_PATTERN = /^\s*local\s+VERSION\b[^\n]*?=\s*"(\d+\.\d+\.\d+)"/m;

/** Reads `local VERSION, … = "x.y.z"` from plugin/bootstrap.luau so hubs running an older bootstrap can be flagged (§8). */
export function readBootstrapVersion(root: string = PACKAGE_ROOT): string | null {
  try {
    const source = fs.readFileSync(path.join(root, 'plugin', 'bootstrap.luau'), 'utf8');
    return BOOTSTRAP_VERSION_PATTERN.exec(source)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function readPackageVersion(root: string = PACKAGE_ROOT): string {
  try {
    const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const version = (parsed as { version: unknown }).version;
      if (typeof version === 'string') return version;
    }
  } catch {
    // fall through: a missing manifest is not fatal for the bridge
  }
  return '0.0.0';
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BridgeError('bad_config', `STUDIO_LIVE_PORT must be an integer in 1..65535, got "${raw}"`);
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const home = env.STUDIO_LIVE_HOME && env.STUDIO_LIVE_HOME !== ''
    ? path.resolve(env.STUDIO_LIVE_HOME)
    : path.join(os.homedir(), '.studio-live');
  return {
    port: parsePort(env.STUDIO_LIVE_PORT),
    home,
    skillsDir: path.join(home, 'skills'),
    persistDir: path.join(home, 'persist'),
    builtinSkillsDir: path.join(PACKAGE_ROOT, 'skills', 'builtin'),
    runtimeDir: path.join(PACKAGE_ROOT, 'plugin', 'runtime'),
    packageRoot: PACKAGE_ROOT,
    dev: env.STUDIO_LIVE_DEV === '1',
    logLevel: parseLogLevel(env.STUDIO_LIVE_LOG),
    geometryPolicy: parseGeometryPolicy(env.STUDIO_LIVE_GEOMETRY_POLICY),
    version: readPackageVersion(),
    bootstrapVersion: readBootstrapVersion(),
  };
}
