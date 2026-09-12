import fsp from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './errors.js';
import type { JsonObject } from './protocol.js';

const SKILL_EXTENSION = '.luau';
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEADER_PATTERN = /^--\[\[[ \t]*studio-live skill[ \t]*\r?\n([\s\S]*?)\r?\n\]\][ \t]*(?:\r?\n|$)/;

export interface SkillMeta {
  name: string;
  description: string;
  params: JsonObject | null;
}

export interface SkillSummary extends SkillMeta {
  path: string;
  bytes: number;
  modified_ms: number;
  /** Shipped with the package (read-only). A user skill of the same name hides it (`overrides_builtin`). */
  builtin: boolean;
  overrides_builtin?: boolean;
}

export interface Skill extends SkillMeta {
  path: string;
  /** Luau source without the header block. */
  source: string;
  builtin: boolean;
}

export interface SkillSaveInput {
  name: string;
  source: string;
  description?: string;
  params?: JsonObject;
}

export function isValidSkillName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

function assertName(name: string): void {
  if (!isValidSkillName(name)) {
    throw new BridgeError('bad_request', `invalid skill name "${name}": use letters, digits, '_' or '-' (max 64 chars)`);
  }
}

function parseParams(raw: string | undefined): JsonObject | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
  } catch {
    return null;
  }
}

/** Splits the leading `--[[ studio-live skill … ]]` block from the body. Returns null when there is no header. */
export function parseSkillHeader(text: string): { meta: Partial<SkillMeta>; body: string } | null {
  const match = HEADER_PATTERN.exec(text);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    fields.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }
  const meta: Partial<SkillMeta> = {};
  const name = fields.get('name');
  if (name) meta.name = name;
  const description = fields.get('description');
  if (description !== undefined) meta.description = description;
  if (fields.has('params')) meta.params = parseParams(fields.get('params'));
  return { meta, body: text.slice(match[0].length) };
}

export function renderSkillFile(meta: SkillMeta, body: string): string {
  const description = meta.description.replace(/\s*\r?\n\s*/g, ' ').trim();
  const header = [
    '--[[ studio-live skill',
    `name: ${meta.name}`,
    `description: ${description}`,
    `params: ${JSON.stringify(meta.params ?? {})}`,
    ']]',
  ].join('\n');
  return `${header}\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readSkillFile(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Skills are Luau programs on disk. User skills live under `<home>/skills/<name>.luau`;
 * builtin skills ship read-only in the package (`<package root>/skills/builtin`). A user
 * skill with a builtin's name overrides it; deleting the override reveals the builtin again.
 */
export class SkillStore {
  constructor(
    readonly dir: string,
    readonly builtinDir: string | null = null,
  ) {}

  pathFor(name: string): string {
    assertName(name);
    return path.join(this.dir, `${name}${SKILL_EXTENSION}`);
  }

  builtinPathFor(name: string): string | null {
    assertName(name);
    return this.builtinDir ? path.join(this.builtinDir, `${name}${SKILL_EXTENSION}`) : null;
  }

  async list(): Promise<SkillSummary[]> {
    const user = await this.listDir(this.dir, false);
    const builtin = this.builtinDir ? await this.listDir(this.builtinDir, true) : [];
    const userNames = new Set(user.map((s) => s.name));
    const builtinNames = new Set(builtin.map((s) => s.name));
    for (const skill of user) if (builtinNames.has(skill.name)) skill.overrides_builtin = true;
    return [...user, ...builtin.filter((s) => !userNames.has(s.name))].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<Skill> {
    const file = this.pathFor(name);
    let text = await readSkillFile(file);
    let builtin = false;
    let where = file;
    if (text === null) {
      const builtinFile = this.builtinPathFor(name);
      if (builtinFile) {
        text = await readSkillFile(builtinFile);
        builtin = text !== null;
        where = builtinFile;
      }
    }
    if (text === null) throw new BridgeError('not_found', `skill "${name}" not found`, { path: file });
    const parsed = parseSkillHeader(text);
    return {
      name,
      description: parsed?.meta.description ?? '',
      params: parsed?.meta.params ?? null,
      path: where,
      source: parsed ? parsed.body : text,
      builtin,
    };
  }

  /** Writes the skill to the user dir; a header already present in `source` supplies defaults and is replaced. */
  async save(input: SkillSaveInput): Promise<{ path: string; replaced: boolean; overrides_builtin: boolean }> {
    const file = this.pathFor(input.name);
    const parsed = parseSkillHeader(input.source);
    const body = parsed ? parsed.body : input.source;
    const meta: SkillMeta = {
      name: input.name,
      description: input.description ?? parsed?.meta.description ?? '',
      params: input.params ?? parsed?.meta.params ?? null,
    };
    await fsp.mkdir(this.dir, { recursive: true });
    let replaced = false;
    try {
      await fsp.access(file);
      replaced = true;
    } catch {
      // new skill
    }
    await fsp.writeFile(file, renderSkillFile(meta, body), 'utf8');
    return { path: file, replaced, overrides_builtin: await this.isBuiltin(input.name) };
  }

  /** Deletes a user skill. A builtin cannot be deleted; deleting its user override makes the builtin visible again. */
  async delete(name: string): Promise<{ deleted: boolean; builtin_visible?: boolean }> {
    const file = this.pathFor(name);
    try {
      await fsp.unlink(file);
    } catch (err) {
      if (!isMissing(err)) throw err;
      if (await this.isBuiltin(name)) {
        throw new BridgeError('bad_request', `"${name}" is a builtin skill and cannot be deleted; save a skill with that name to override it`);
      }
      return { deleted: false };
    }
    return (await this.isBuiltin(name)) ? { deleted: true, builtin_visible: true } : { deleted: true };
  }

  async isBuiltin(name: string): Promise<boolean> {
    const file = this.builtinPathFor(name);
    if (!file) return false;
    try {
      await fsp.access(file);
      return true;
    } catch {
      return false;
    }
  }

  private async listDir(dir: string, builtin: boolean): Promise<SkillSummary[]> {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    const skills: SkillSummary[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(SKILL_EXTENSION)) continue;
      const name = entry.slice(0, -SKILL_EXTENSION.length);
      if (!isValidSkillName(name)) continue;
      const file = path.join(dir, entry);
      const [text, stat] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
      const parsed = parseSkillHeader(text);
      skills.push({
        name,
        description: parsed?.meta.description ?? '',
        params: parsed?.meta.params ?? null,
        path: file,
        bytes: stat.size,
        modified_ms: Math.round(stat.mtimeMs),
        builtin,
      });
    }
    return skills;
  }
}
