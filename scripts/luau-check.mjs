// Parses and type-checks every plugin/**/*.luau with luau-lsp against the Roblox API definitions, using
// a sourcemap that mirrors the bootstrap's tree rules (protocol.md §1.1 step 3: one Folder per path
// segment, "init" as a plain ModuleScript) so cross-module requires resolve. The definitions file is
// fetched once into %TEMP%\studio-live\luau (override with STUDIO_LIVE_LUAU_DEFS). Exit code = luau-lsp's.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFS_URL = 'https://raw.githubusercontent.com/JohnnyMorganz/luau-lsp/main/scripts/globalTypes.d.luau';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(root, 'plugin');
const cacheDir = path.join(os.tmpdir(), 'studio-live', 'luau');
mkdirSync(cacheDir, { recursive: true });

function listLuau(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listLuau(full));
    else if (name.endsWith('.luau')) out.push(full);
  }
  return out;
}

function treeOf(dir) {
  const children = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      children.push({ name, className: 'Folder', filePaths: [], children: treeOf(full) });
    } else if (name.endsWith('.luau')) {
      children.push({ name: name.slice(0, -'.luau'.length), className: 'ModuleScript', filePaths: [path.relative(root, full).split(path.sep).join('/')], children: [] });
    }
  }
  return children;
}

const files = listLuau(pluginDir);
// A UTF-8 BOM is a syntax error for the Luau parser, and Studio would reject the packed bootstrap too.
const withBom = files.filter((file) => {
  const head = readFileSync(file).subarray(0, 3);
  return head.length === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
});
if (withBom.length > 0) {
  console.error(`luau-check: UTF-8 BOM found in ${withBom.map((f) => path.relative(root, f)).join(', ')}`);
  process.exit(1);
}

const defs = process.env.STUDIO_LIVE_LUAU_DEFS || path.join(cacheDir, 'globalTypes.d.luau');
if (!existsSync(defs)) {
  const response = await fetch(DEFS_URL);
  if (!response.ok) {
    console.error(`luau-check: could not fetch ${DEFS_URL} (HTTP ${response.status}); set STUDIO_LIVE_LUAU_DEFS to a local copy`);
    process.exit(2);
  }
  writeFileSync(defs, await response.text());
  console.error(`luau-check: fetched Roblox definitions into ${defs}`);
}

const sourcemap = path.join(cacheDir, 'sourcemap.json');
writeFileSync(
  sourcemap,
  JSON.stringify({
    name: 'StudioLiveRuntime',
    className: 'Folder',
    filePaths: [],
    children: [
      { name: 'runtime', className: 'Folder', filePaths: [], children: treeOf(path.join(pluginDir, 'runtime')) },
      { name: 'bootstrap', className: 'Script', filePaths: ['plugin/bootstrap.luau'], children: [] },
    ],
  }),
);

// npx is a .cmd on Windows and needs a shell; the shell gets one pre-quoted command line.
const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
const args = ['--yes', 'luau-lsp', 'analyze', `--definitions=${defs}`, `--sourcemap=${sourcemap}`, '--no-strict-dm-types', ...files];
console.error(`luau-check: analyzing ${files.length} files`);
const result = spawnSync(`npx ${args.map(quote).join(' ')}`, { cwd: root, stdio: 'inherit', shell: true });
if (result.error) {
  console.error(`luau-check: could not run npx: ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
