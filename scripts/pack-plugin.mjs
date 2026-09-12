// Packs plugin/bootstrap.luau into dist/StudioLive.rbxmx (Roblox XML model, one Script item)
// and mirrors it as dist/StudioLive.lua. Exit 0 with a warning when the bootstrap is absent so
// the rest of the build can proceed while the bootstrap is authored separately.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = 'StudioLive';

/** Wraps text in CDATA; a literal "]]>" inside the source would end the section early, so it is split. */
export function cdata(text) {
  return `<![CDATA[${text.split(']]>').join(']]]]><![CDATA[>')}]]>`;
}

/**
 * Same envelope Studio writes for a single-Script plugin: roblox version 4, one Item, Name,
 * RunContext 0 (Legacy) and the Source. Source is a ProtectedString in Roblox's own schema;
 * Studio reads it either way, and CDATA keeps the Luau byte-for-byte.
 */
export function buildRbxmx(source, name = PLUGIN_NAME) {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<roblox version="4">',
    '  <Item class="Script" referent="0">',
    '    <Properties>',
    `      <string name="Name">${escapeXml(name)}</string>`,
    '      <token name="RunContext">0</token>',
    `      <ProtectedString name="Source">${cdata(source)}</ProtectedString>`,
    '    </Properties>',
    '  </Item>',
    '</roblox>',
    '',
  ];
  return lines.join('\n');
}

function escapeXml(text) {
  return text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

export function packPlugin(root) {
  const bootstrap = path.join(root, 'plugin', 'bootstrap.luau');
  const dist = path.join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  if (!existsSync(bootstrap)) {
    const note = path.join(dist, `${PLUGIN_NAME}.NOT_PACKED.txt`);
    writeFileSync(note, `${PLUGIN_NAME}.rbxmx was not produced: ${bootstrap} does not exist.\nWrite plugin/bootstrap.luau and run "npm run pack:plugin".\n`);
    console.error(`pack-plugin: WARNING ${path.relative(root, bootstrap)} is missing; wrote ${path.relative(root, note)} instead`);
    return { packed: false, note };
  }
  const source = readFileSync(bootstrap, 'utf8');
  const rbxmx = path.join(dist, `${PLUGIN_NAME}.rbxmx`);
  const lua = path.join(dist, `${PLUGIN_NAME}.lua`);
  writeFileSync(rbxmx, buildRbxmx(source), 'utf8');
  copyFileSync(bootstrap, lua);
  console.error(`pack-plugin: ${path.relative(root, rbxmx)} (${source.length} chars of Luau) and ${path.relative(root, lua)}`);
  return { packed: true, rbxmx, lua };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  packPlugin(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
