import { describe, expect, it } from 'vitest';
import { fileNameIssue, fileOfInstance, instancePathOf, isHotpatchable, isIgnoredRel, mapFiles, parseLuauFileName } from '../../bridge/src/sync/layout.js';

describe('parseLuauFileName', () => {
  it('maps suffixes to classes and recognises init files', () => {
    expect(parseLuauFileName('Main.server.luau')).toEqual({ name: 'Main', class: 'Script', init: false });
    expect(parseLuauFileName('Hud.client.luau')).toEqual({ name: 'Hud', class: 'LocalScript', init: false });
    expect(parseLuauFileName('Util.luau')).toEqual({ name: 'Util', class: 'ModuleScript', init: false });
    expect(parseLuauFileName('init.server.luau')).toEqual({ name: 'init', class: 'Script', init: true });
    expect(parseLuauFileName('init.luau')).toEqual({ name: 'init', class: 'ModuleScript', init: true });
    expect(parseLuauFileName('Foo.bar.luau')).toEqual({ name: 'Foo.bar', class: 'ModuleScript', init: false });
    expect(parseLuauFileName('Readme.md')).toBeNull();
    expect(parseLuauFileName('.server.luau')).toBeNull();
    expect(parseLuauFileName('Main.lua')).toBeNull();
  });
});

describe('mapFiles', () => {
  it('maps files to services, folders and script classes', () => {
    const { entries, issues } = mapFiles([
      'ServerScriptService/Main.server.luau',
      'ReplicatedStorage/Shared/Util.luau',
      'StarterPlayer/StarterPlayerScripts/Input.client.luau',
      'Workspace/Door/DoorScript.server.luau',
    ]);
    expect(issues).toEqual([]);
    expect(entries.get('ServerScriptService/Main.server.luau')).toMatchObject({
      service: 'ServerScriptService',
      parents: [],
      name: 'Main',
      class: 'Script',
      names: ['ServerScriptService', 'Main'],
      instancePath: 'ServerScriptService.Main',
    });
    expect(entries.get('ReplicatedStorage/Shared/Util.luau')).toMatchObject({
      parents: [{ name: 'Shared', class: 'Folder' }],
      name: 'Util',
      class: 'ModuleScript',
      instancePath: 'ReplicatedStorage.Shared.Util',
    });
    expect(entries.get('StarterPlayer/StarterPlayerScripts/Input.client.luau')).toMatchObject({
      service: 'StarterPlayer',
      parents: [{ name: 'StarterPlayerScripts', class: 'Folder' }],
      class: 'LocalScript',
      instancePath: 'StarterPlayer.StarterPlayerScripts.Input',
    });
    expect(entries.get('Workspace/Door/DoorScript.server.luau')?.parents).toEqual([{ name: 'Door', class: 'Folder' }]);
  });

  it('applies the Rojo init convention: the directory becomes the script and siblings its children', () => {
    const { entries, issues } = mapFiles(['ServerScriptService/Game/init.server.luau', 'ServerScriptService/Game/Combat.luau', 'ServerScriptService/Game/Sub/Deep.luau']);
    expect(issues).toEqual([]);
    expect(entries.get('ServerScriptService/Game/init.server.luau')).toMatchObject({
      parents: [],
      name: 'Game',
      class: 'Script',
      names: ['ServerScriptService', 'Game'],
      instancePath: 'ServerScriptService.Game',
    });
    expect(entries.get('ServerScriptService/Game/Combat.luau')).toMatchObject({
      parents: [{ name: 'Game', class: 'Script' }],
      name: 'Combat',
      class: 'ModuleScript',
      instancePath: 'ServerScriptService.Game.Combat',
    });
    expect(entries.get('ServerScriptService/Game/Sub/Deep.luau')?.parents).toEqual([
      { name: 'Game', class: 'Script' },
      { name: 'Sub', class: 'Folder' },
    ]);
  });

  it('reports files it cannot place instead of guessing', () => {
    const { entries, issues } = mapFiles([
      'loose.luau',
      'ServerScriptService/init.luau',
      'ServerScriptService/Game/init.server.luau',
      'ServerScriptService/Game/init.luau',
      'ServerScriptService/Game.server.luau',
      'ServerScriptService/Ok.server.luau',
    ]);
    expect([...entries.keys()]).toEqual(['ServerScriptService/Game/init.server.luau', 'ServerScriptService/Ok.server.luau']);
    expect(issues.map((i) => i.rel)).toEqual(['ServerScriptService/Game.server.luau', 'ServerScriptService/Game/init.luau', 'ServerScriptService/init.luau', 'loose.luau']);
    expect(issues.find((i) => i.rel === 'ServerScriptService/Game.server.luau')?.reason).toMatch(/ambiguous/);
    expect(issues.find((i) => i.rel === 'loose.luau')?.reason).toMatch(/service directory/);
  });

  it('quotes instance path segments the way the hub does', () => {
    expect(instancePathOf(['Workspace', 'a.b', 'Child'])).toBe('Workspace["a.b"].Child');
    expect(instancePathOf(['ServerScriptService', 'Main'])).toBe('ServerScriptService.Main');
    expect(mapFiles(['Workspace/a.b/Foo.luau']).entries.get('Workspace/a.b/Foo.luau')?.instancePath).toBe('Workspace["a.b"].Foo');
  });
});

describe('fileOfInstance (pull direction)', () => {
  it('produces flat files and init directories', () => {
    expect(fileOfInstance(['ServerScriptService', 'Main'], 'Script', false)).toEqual({ ok: true, rel: 'ServerScriptService/Main.server.luau' });
    expect(fileOfInstance(['ServerScriptService', 'Game'], 'Script', true)).toEqual({ ok: true, rel: 'ServerScriptService/Game/init.server.luau' });
    expect(fileOfInstance(['ServerScriptService', 'Game', 'Combat'], 'ModuleScript', false)).toEqual({ ok: true, rel: 'ServerScriptService/Game/Combat.luau' });
    expect(fileOfInstance(['StarterPlayer', 'StarterPlayerScripts', 'Hud'], 'LocalScript', false)).toEqual({ ok: true, rel: 'StarterPlayer/StarterPlayerScripts/Hud.client.luau' });
  });

  it('round-trips through mapFiles', () => {
    const chains: Array<[string[], 'Script' | 'LocalScript' | 'ModuleScript', boolean]> = [
      [['ServerScriptService', 'Main'], 'Script', false],
      [['ServerScriptService', 'Game'], 'Script', true],
      [['ServerScriptService', 'Game', 'Combat'], 'ModuleScript', false],
      [['ReplicatedStorage', 'Shared', 'Types'], 'ModuleScript', false],
    ];
    const rels = chains.map(([n, c, d]) => {
      const f = fileOfInstance(n, c, d);
      if (!f.ok) throw new Error(f.reason);
      return f.rel;
    });
    const { entries, issues } = mapFiles(rels);
    expect(issues).toEqual([]);
    chains.forEach(([names, cls], i) => {
      expect(entries.get(rels[i] as string)).toMatchObject({ names, class: cls });
    });
  });

  it('refuses names that would not map back or cannot be files', () => {
    expect(fileOfInstance(['ServerScriptService', 'init'], 'ModuleScript', false)).toMatchObject({ ok: false });
    expect(fileOfInstance(['ServerScriptService', 'Foo.server'], 'ModuleScript', false)).toMatchObject({ ok: false });
    expect(fileOfInstance(['ServerScriptService', 'a/b'], 'Script', false)).toMatchObject({ ok: false });
    expect(fileOfInstance(['ServerScriptService', '.hidden', 'X'], 'Script', false)).toMatchObject({ ok: false });
    expect(fileOfInstance(['Main'], 'Script', false)).toMatchObject({ ok: false });
    expect(fileNameIssue('CON')).toMatch(/reserved/);
    expect(fileNameIssue('trailing.')).toMatch(/dot or a space/);
    expect(fileNameIssue('Fine-Name_1')).toBeNull();
  });
});

describe('hotpatch eligibility and ignores', () => {
  it('hot-patches server-side Scripts and ModuleScripts only', () => {
    expect(isHotpatchable({ service: 'ServerScriptService', class: 'Script' })).toBe(true);
    expect(isHotpatchable({ service: 'ReplicatedStorage', class: 'ModuleScript' })).toBe(true);
    expect(isHotpatchable({ service: 'Workspace', class: 'Script' })).toBe(true);
    expect(isHotpatchable({ service: 'ServerStorage', class: 'LocalScript' })).toBe(false);
    expect(isHotpatchable({ service: 'StarterPlayer', class: 'ModuleScript' })).toBe(false);
    expect(isHotpatchable({ service: 'StarterGui', class: 'Script' })).toBe(false);
  });

  it('ignores dot-directories and non-.luau files', () => {
    expect(isIgnoredRel('.git/config')).toBe(true);
    expect(isIgnoredRel('.studio-live-sync.json')).toBe(true);
    expect(isIgnoredRel('ServerScriptService/.hidden/x.luau')).toBe(true);
    expect(isIgnoredRel('ServerScriptService/notes.md')).toBe(true);
    expect(isIgnoredRel('ServerScriptService\\Main.server.luau')).toBe(false);
  });
});
