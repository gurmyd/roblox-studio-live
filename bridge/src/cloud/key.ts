import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * API key resolution. The key is looked up on EVERY call and never cached, so it
 * can be rotated or replaced without restarting the bridge:
 *   1. env ROBLOX_OPEN_CLOUD_KEY
 *   2. <home>/opencloud.json   {"key": "…"}
 *   3. <home>/opencloud.key    plain text
 */
export const KEY_ENV = 'ROBLOX_OPEN_CLOUD_KEY';
export const KEY_JSON_FILE = 'opencloud.json';
export const KEY_TEXT_FILE = 'opencloud.key';

export type KeySource = 'env' | 'json' | 'file';
export type KeyResolution = { ok: true; key: string; source: KeySource } | { ok: false; problems: string[] };

export function keyPaths(home: string): { json: string; file: string } {
  return { json: path.join(home, KEY_JSON_FILE), file: path.join(home, KEY_TEXT_FILE) };
}

type ReadOutcome = { kind: 'text'; text: string } | { kind: 'missing' } | { kind: 'error'; message: string };

/**
 * Reads a file as UTF-8 and drops a leading byte-order mark. PowerShell's `Out-File` /
 * `Set-Content -Encoding utf8` and Notepad's default "UTF-8 with BOM" all write one, and
 * JSON.parse rejects it, so both key files tolerate it explicitly.
 */
async function readTextFile(file: string): Promise<ReadOutcome> {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return { kind: 'text', text: text.replace(/^\uFEFF/, '') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

function usable(raw: string, where: string, problems: string[]): string | null {
  // Explicit BOM strip (not just trim) so a plain-text key file written by PowerShell / Notepad works.
  const key = raw.replace(/^\uFEFF/, '').trim();
  if (key === '') {
    problems.push(`${where} is present but empty`);
    return null;
  }
  if (/[\r\n]/.test(key)) {
    problems.push(`${where} contains a line break inside the key`);
    return null;
  }
  return key;
}

export async function resolveKey(home: string, env: NodeJS.ProcessEnv = process.env): Promise<KeyResolution> {
  const problems: string[] = [];
  const fromEnv = env[KEY_ENV];
  if (typeof fromEnv === 'string') {
    const key = usable(fromEnv, `env ${KEY_ENV}`, problems);
    if (key) return { ok: true, key, source: 'env' };
  }

  const { json, file } = keyPaths(home);
  const jsonRead = await readTextFile(json);
  if (jsonRead.kind === 'text') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonRead.text);
    } catch {
      problems.push(`${json} is not valid JSON (expected {"key":"…"})`);
    }
    if (parsed !== undefined) {
      const candidate = typeof parsed === 'object' && parsed !== null ? (parsed as { key?: unknown }).key : undefined;
      if (typeof candidate === 'string') {
        const key = usable(candidate, `"key" in ${json}`, problems);
        if (key) return { ok: true, key, source: 'json' };
      } else {
        problems.push(`${json} has no "key" string (expected {"key":"…"})`);
      }
    }
  } else if (jsonRead.kind === 'error') {
    problems.push(`${json}: ${jsonRead.message}`);
  }

  const fileRead = await readTextFile(file);
  if (fileRead.kind === 'text') {
    const key = usable(fileRead.text, file, problems);
    if (key) return { ok: true, key, source: 'file' };
  } else if (fileRead.kind === 'error') {
    problems.push(`${file}: ${fileRead.message}`);
  }

  return { ok: false, problems };
}

export function describeKeySource(source: KeySource, home: string): string {
  const { json, file } = keyPaths(home);
  switch (source) {
    case 'env':
      return `env ${KEY_ENV}`;
    case 'json':
      return json;
    case 'file':
      return file;
  }
}
