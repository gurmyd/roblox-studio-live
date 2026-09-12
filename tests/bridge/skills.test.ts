import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../../bridge/src/config.js';
import { parseSkillHeader, SkillStore } from '../../bridge/src/skills.js';

const BUILTIN_DIR = path.join(PACKAGE_ROOT, 'skills', 'builtin');
const EXPECTED_BUILTINS = ['bulk_attributes', 'device_sim', 'insert_asset', 'lighting_preset', 'list_scripts', 'profile_scripts', 'remote_map', 'settle_physics'];

describe('shipped builtin skills', () => {
  it('ship every documented builtin with a well-formed header and a params object', async () => {
    const entries = (await fsp.readdir(BUILTIN_DIR)).filter((f) => f.endsWith('.luau')).sort();
    expect(entries.map((f) => f.slice(0, -'.luau'.length))).toEqual(EXPECTED_BUILTINS);
    for (const entry of entries) {
      const name = entry.slice(0, -'.luau'.length);
      const text = await fsp.readFile(path.join(BUILTIN_DIR, entry), 'utf8');
      expect(text.charCodeAt(0), `${entry} must not start with a BOM`).not.toBe(0xfeff);
      const parsed = parseSkillHeader(text);
      expect(parsed, `${entry} has no studio-live skill header`).not.toBeNull();
      expect(parsed?.meta.name).toBe(name);
      expect(parsed?.meta.description?.length ?? 0, `${entry} description`).toBeGreaterThan(40);
      expect(parsed?.meta.params, `${entry} params must be a JSON object`).toBeTypeOf('object');
      expect(parsed?.meta.params).not.toBeNull();
      expect(Object.keys(parsed?.meta.params ?? {}).length, `${entry} params must document at least one ARG`).toBeGreaterThan(0);
      // Every skill is a program against the S API: it must use S or ARGS and end with a return value.
      expect(parsed?.body).toMatch(/\bS\.|\bARGS\b/);
      expect(parsed?.body.trimEnd()).toMatch(/\breturn\b[\s\S]*$/);
      // The builtins run through `run`: no `plugin` global (plugin:GetSetting …), no require of runtime modules.
      expect(parsed?.body).not.toMatch(/\bplugin\s*[:.]/);
      expect(parsed?.body).not.toMatch(/\brequire\(/);
    }
  });
});

describe('SkillStore with builtins', () => {
  let userDir: string;
  let builtinDir: string;
  let store: SkillStore;

  beforeAll(async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-builtins-'));
    userDir = path.join(root, 'user');
    builtinDir = path.join(root, 'builtin');
    await fsp.mkdir(builtinDir, { recursive: true });
    await fsp.writeFile(
      path.join(builtinDir, 'shipped.luau'),
      '--[[ studio-live skill\nname: shipped\ndescription: ships with the bridge\nparams: {"n":{"type":"integer"}}\n]]\nreturn ARGS.n\n',
      'utf8',
    );
    store = new SkillStore(userDir, builtinDir);
  });

  afterAll(async () => {
    await fsp.rm(path.dirname(userDir), { recursive: true, force: true });
  });

  it('lists builtins as builtin:true even when the user dir does not exist, and gets them', async () => {
    const listed = await store.list();
    expect(listed).toEqual([expect.objectContaining({ name: 'shipped', builtin: true, description: 'ships with the bridge', params: { n: { type: 'integer' } } })]);
    const skill = await store.get('shipped');
    expect(skill).toMatchObject({ name: 'shipped', builtin: true, source: 'return ARGS.n\n', path: path.join(builtinDir, 'shipped.luau') });
    expect(await store.isBuiltin('shipped')).toBe(true);
    expect(await store.isBuiltin('other')).toBe(false);
  });

  it('refuses to delete a builtin, lets a user override win, and restores the builtin when the override goes', async () => {
    await expect(store.delete('shipped')).rejects.toMatchObject({ code: 'bad_request' });
    expect(await store.delete('never-existed')).toEqual({ deleted: false });

    const saved = await store.save({ name: 'shipped', source: 'return 2', description: 'mine' });
    expect(saved).toMatchObject({ replaced: false, overrides_builtin: true, path: path.join(userDir, 'shipped.luau') });
    expect(await store.get('shipped')).toMatchObject({ builtin: false, source: 'return 2\n', description: 'mine' });
    const listed = await store.list();
    expect(listed).toEqual([expect.objectContaining({ name: 'shipped', builtin: false, overrides_builtin: true })]);

    await store.save({ name: 'own', source: 'return 1' });
    expect((await store.list()).map((s) => `${s.name}:${s.builtin}`)).toEqual(['own:false', 'shipped:false']);

    expect(await store.delete('shipped')).toEqual({ deleted: true, builtin_visible: true });
    expect(await store.get('shipped')).toMatchObject({ builtin: true, source: 'return ARGS.n\n' });
    expect(await store.delete('own')).toEqual({ deleted: true });
    expect((await store.list()).map((s) => s.name)).toEqual(['shipped']);
  });

  it('works without a builtin dir exactly as before', async () => {
    const plain = new SkillStore(path.join(path.dirname(userDir), 'plain'));
    expect(plain.builtinDir).toBeNull();
    expect(await plain.list()).toEqual([]);
    await expect(plain.get('shipped')).rejects.toMatchObject({ code: 'not_found' });
    expect(await plain.delete('shipped')).toEqual({ deleted: false });
  });
});
