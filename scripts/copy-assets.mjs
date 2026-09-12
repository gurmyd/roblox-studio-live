// Copies non-TypeScript runtime assets into dist next to their compiled modules.
// tsc only emits .ts -> .js; worker.ps1 must sit beside dist/.../capture/index.js because
// index.ts resolves it relative to import.meta.url.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = ['bridge/src/capture/worker.ps1'];

// Mirror tsconfig's rootDir/outDir mapping so the copy lands wherever tsc put the module.
const tsconfig = JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
const rootDir = path.resolve(root, tsconfig.compilerOptions?.rootDir ?? '.');
const outDir = path.resolve(root, tsconfig.compilerOptions?.outDir ?? 'dist');

for (const asset of ASSETS) {
  const src = path.join(root, asset);
  const dest = path.join(outDir, path.relative(rootDir, src));
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.error(`copy-assets: ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
}
