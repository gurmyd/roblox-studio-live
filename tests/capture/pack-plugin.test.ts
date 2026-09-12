import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRbxmx, cdata, packPlugin } from '../../scripts/pack-plugin.mjs';

describe('buildRbxmx', () => {
  it('emits the single-Script envelope Studio expects', () => {
    const xml = buildRbxmx('print("hi")\n');
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<roblox version="4">\n  <Item class="Script" referent="0">\n    <Properties>\n')).toBe(true);
    expect(xml).toContain('<string name="Name">StudioLive</string>');
    expect(xml).toContain('<token name="RunContext">0</token>');
    expect(xml).toContain('<ProtectedString name="Source"><![CDATA[print("hi")\n]]></ProtectedString>');
    expect(xml.trimEnd().endsWith('</Item>\n</roblox>')).toBe(true);
    expect((xml.match(/<Item /g) ?? []).length).toBe(1);
  });

  it('splits "]]>" so the CDATA section cannot terminate early', () => {
    const source = 'local s = "a]]>b"\nlocal t = [[x]]>y]]';
    const wrapped = cdata(source);
    expect(wrapped).toBe('<![CDATA[local s = "a]]]]><![CDATA[>b"\nlocal t = [[x]]]]><![CDATA[>y]]]]>');
    // Every CDATA section in the output must be well-formed: no "]]>" inside one except as its terminator.
    const sections = wrapped.split('<![CDATA[').slice(1);
    for (const s of sections) {
      const end = s.indexOf(']]>');
      expect(end).toBeGreaterThanOrEqual(0);
      expect(s.slice(0, end)).not.toContain(']]>');
    }
    // Decoding the sections back yields the original source byte-for-byte.
    const decoded = sections.map((s) => s.slice(0, s.indexOf(']]>'))).join('');
    expect(decoded).toBe(source);
  });

  it('escapes the plugin name for XML', () => {
    expect(buildRbxmx('', 'A&B<C>')).toContain('<string name="Name">A&amp;B&lt;C&gt;</string>');
  });
});

describe('packPlugin', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-live-pack-test-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes dist/StudioLive.rbxmx and dist/StudioLive.lua from plugin/bootstrap.luau', async () => {
    await fs.mkdir(path.join(root, 'plugin'), { recursive: true });
    await fs.writeFile(path.join(root, 'plugin', 'bootstrap.luau'), '-- bootstrap\nreturn 1\n');
    const result = packPlugin(root);
    expect(result.packed).toBe(true);
    expect(await fs.readFile(path.join(root, 'dist', 'StudioLive.lua'), 'utf8')).toBe('-- bootstrap\nreturn 1\n');
    const xml = await fs.readFile(path.join(root, 'dist', 'StudioLive.rbxmx'), 'utf8');
    expect(xml).toContain('<![CDATA[-- bootstrap\nreturn 1\n]]>');
  });

  it('warns and writes a note instead of an rbxmx when the bootstrap is missing', async () => {
    const result = packPlugin(root);
    expect(result.packed).toBe(false);
    await expect(fs.access(path.join(root, 'dist', 'StudioLive.rbxmx'))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'dist', 'StudioLive.NOT_PACKED.txt'), 'utf8')).toMatch(/bootstrap\.luau/);
  });
});
