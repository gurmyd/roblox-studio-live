/**
 * File layout ↔ instance mapping for the Rojo-lite sync (docs/sync.md).
 *
 *   <dir>/<Service>/<Folder…>/<Name>.server.luau  → Script
 *   <dir>/<Service>/<Folder…>/<Name>.client.luau  → LocalScript
 *   <dir>/<Service>/<Folder…>/<Name>.luau         → ModuleScript
 *   <dir>/<Service>/<Folder…>/<Name>/init.*.luau  → that script, with the directory's other files as children
 *   any other directory                            → Folder (or an existing instance of that name)
 *
 * Pure functions only: the scanner hands in relative POSIX paths, this module says what they mean.
 */

export type ScriptClass = 'Script' | 'LocalScript' | 'ModuleScript';

export const SCRIPT_CLASSES: readonly ScriptClass[] = ['Script', 'LocalScript', 'ModuleScript'];

const SUFFIX_OF: Record<ScriptClass, string> = { Script: '.server.luau', LocalScript: '.client.luau', ModuleScript: '.luau' };

/** Services whose scripts run on the server, so a push can be hot-patched into a live play-server DM. */
export const SERVER_SIDE_SERVICES: ReadonlySet<string> = new Set(['ServerScriptService', 'ServerStorage', 'ReplicatedStorage', 'Workspace']);

/** Init files in order of preference when a directory holds more than one. */
const INIT_FILES: ReadonlyArray<{ base: string; class: ScriptClass }> = [
  { base: 'init.server.luau', class: 'Script' },
  { base: 'init.client.luau', class: 'LocalScript' },
  { base: 'init.luau', class: 'ModuleScript' },
];

export interface ParsedName {
  /** Instance name (`Main` for `Main.server.luau`). */
  name: string;
  class: ScriptClass;
  /** True for `init.luau` / `init.server.luau` / `init.client.luau`. */
  init: boolean;
}

/** Interprets a file basename; null when it is not a `.luau` file. */
export function parseLuauFileName(base: string): ParsedName | null {
  if (!base.endsWith('.luau')) return null;
  let stem = base.slice(0, -'.luau'.length);
  let cls: ScriptClass = 'ModuleScript';
  if (stem.endsWith('.server')) {
    cls = 'Script';
    stem = stem.slice(0, -'.server'.length);
  } else if (stem.endsWith('.client')) {
    cls = 'LocalScript';
    stem = stem.slice(0, -'.client'.length);
  }
  if (stem === '') return null;
  return { name: stem, class: cls, init: stem === 'init' };
}

export interface ParentSpec {
  name: string;
  /** `Folder`, or the script class when the directory carries an init file. */
  class: 'Folder' | ScriptClass;
}

export interface FileEntry {
  /** Relative POSIX path inside the sync dir. */
  rel: string;
  /** Top-level directory = service name. */
  service: string;
  /** Directories between the service and the script (created on push when missing). */
  parents: ParentSpec[];
  /** Instance name. */
  name: string;
  class: ScriptClass;
  /** Full name chain from the service down to the script. */
  names: string[];
  /** Dotted instance path as the bridge / hub expect it. */
  instancePath: string;
}

export interface LayoutIssue {
  rel: string;
  reason: string;
}

export interface Layout {
  entries: Map<string, FileEntry>;
  issues: LayoutIssue[];
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

function baseOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? rel : rel.slice(i + 1);
}

/** Quotes a segment the way the hub's `paths.of` does, so the produced path resolves again. */
function quoteSegment(name: string): string {
  return /[.[\]"']/.test(name) ? `["${name.replace(/"/g, '\\"')}"]` : name;
}

/** Dotted path from a name chain (`Workspace["a.b"].Child`). */
export function instancePathOf(names: readonly string[]): string {
  return names.map(quoteSegment).join('.').replace(/\.\[/g, '[');
}

/**
 * Maps every `.luau` relative path (POSIX separators, no leading `./`) to the instance it
 * stands for. Files that cannot be placed are reported in `issues` and left out.
 */
export function mapFiles(rels: readonly string[]): Layout {
  const entries = new Map<string, FileEntry>();
  const issues: LayoutIssue[] = [];
  const files = [...new Set(rels)].sort();

  // Which directories carry an init file, and which one wins.
  const dirInit = new Map<string, { rel: string; class: ScriptClass }>();
  for (const rel of files) {
    const base = baseOf(rel);
    const init = INIT_FILES.find((f) => f.base === base);
    if (!init) continue;
    const dir = dirOf(rel);
    const current = dirInit.get(dir);
    if (!current || INIT_FILES.findIndex((f) => f.base === baseOf(current.rel)) > INIT_FILES.findIndex((f) => f.base === base)) {
      dirInit.set(dir, { rel, class: init.class });
    }
  }

  for (const rel of files) {
    const parts = rel.split('/');
    const parsed = parseLuauFileName(parts[parts.length - 1] ?? '');
    if (!parsed) continue;
    if (parts.length === 1) {
      issues.push({ rel, reason: 'top-level files are not synced; put scripts under a service directory such as ServerScriptService/' });
      continue;
    }
    const service = parts[0] as string;
    const dirParts = parts.slice(1, -1);
    const parentsOf = (dirs: readonly string[]): ParentSpec[] =>
      dirs.map((name, i) => {
        const prefix = [service, ...dirs.slice(0, i + 1)].join('/');
        return { name, class: dirInit.get(prefix)?.class ?? 'Folder' };
      });

    if (parsed.init) {
      if (dirParts.length === 0) {
        issues.push({ rel, reason: `a service cannot be a script; move it into a sub-directory of ${service}/` });
        continue;
      }
      const dir = dirOf(rel);
      const winner = dirInit.get(dir);
      if (winner && winner.rel !== rel) {
        issues.push({ rel, reason: `ignored: ${winner.rel} already defines this directory's script` });
        continue;
      }
      const name = dirParts[dirParts.length - 1] as string;
      const names = [service, ...dirParts];
      entries.set(rel, { rel, service, parents: parentsOf(dirParts.slice(0, -1)), name, class: parsed.class, names, instancePath: instancePathOf(names) });
      continue;
    }

    const asDir = [service, ...dirParts, parsed.name].join('/');
    if (dirInit.has(asDir)) {
      issues.push({ rel, reason: `ambiguous with ${dirInit.get(asDir)?.rel}; the init file wins` });
      continue;
    }
    const names = [service, ...dirParts, parsed.name];
    entries.set(rel, { rel, service, parents: parentsOf(dirParts), name: parsed.name, class: parsed.class, names, instancePath: instancePathOf(names) });
  }
  return { entries, issues };
}

/** Whether a push of this file can be hot-patched into the live play-server DM. */
export function isHotpatchable(entry: Pick<FileEntry, 'service' | 'class'>): boolean {
  return entry.class !== 'LocalScript' && SERVER_SIDE_SERVICES.has(entry.service);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Reason a name cannot be a file / directory segment on disk, or null when it is fine. */
export function fileNameIssue(name: string): string | null {
  if (name === '' || name === '.' || name === '..') return 'empty or dot name';
  if (name.startsWith('.')) return 'names starting with "." are ignored by the scanner';
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) return 'contains a character that is not allowed in file names';
  if (/[. ]$/.test(name)) return 'ends with a dot or a space';
  if (WINDOWS_RESERVED.test(name)) return 'is a reserved device name on Windows';
  return null;
}

export type InstanceFile = { ok: true; rel: string } | { ok: false; reason: string };

/**
 * File for an instance (pull direction). A script with script descendants becomes a
 * directory with an init file, so its children have somewhere to live.
 */
export function fileOfInstance(names: readonly string[], cls: ScriptClass, hasScriptDescendants: boolean): InstanceFile {
  if (names.length < 2) return { ok: false, reason: 'a script directly under game cannot be synced' };
  for (const name of names) {
    const issue = fileNameIssue(name);
    if (issue) return { ok: false, reason: `"${name}" ${issue}` };
  }
  const suffix = SUFFIX_OF[cls];
  if (hasScriptDescendants) return { ok: true, rel: `${names.join('/')}/init${suffix}` };
  const last = names[names.length - 1] as string;
  const roundTrip = parseLuauFileName(`${last}${suffix}`);
  if (!roundTrip || roundTrip.init || roundTrip.name !== last || roundTrip.class !== cls) {
    return { ok: false, reason: `"${last}" would not map back to the same instance (rename it, or give it a child script)` };
  }
  return { ok: true, rel: `${[...names.slice(0, -1), `${last}${suffix}`].join('/')}` };
}

/** Whether a relative path is ignored by the scanner (dot-directories, dot-files, non-.luau). */
export function isIgnoredRel(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p.startsWith('.'))) return true;
  return !(parts[parts.length - 1] ?? '').endsWith('.luau');
}
