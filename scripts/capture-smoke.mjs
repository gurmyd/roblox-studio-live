// Lists Roblox Studio windows and captures one to the frames dir, printing timings.
// Usage: node scripts/capture-smoke.mjs [--max-width N] [--format jpeg|png] [--title <substring>] [--png] [--count N]
// Requires "npm run build" (imports the compiled capture module); read-only towards Studio.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = path.join(root, 'dist', 'bridge', 'capture', 'index.js');
if (!existsSync(modulePath)) {
  console.error(`capture-smoke: compiled capture module not found at ${modulePath}; run "npm run build" first`);
  process.exit(2);
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const format = args.includes('--png') ? 'png' : flag('--format', 'jpeg');
const maxWidth = Number(flag('--max-width', '1024'));
const titleMatch = flag('--title', undefined);
const count = Number(flag('--count', '2'));

const { listStudioWindows, captureStudio, shutdownCaptureWorker } = await import(pathToFileURL(modulePath).href);

const ms = (t0) => (performance.now() - t0).toFixed(1);
try {
  let t0 = performance.now();
  const windows = await listStudioWindows();
  console.log(`list: ${windows.length} window(s) in ${ms(t0)} ms (includes worker spawn on first call)`);
  for (const w of windows) {
    console.log(`  hwnd=${w.hwnd} pid=${w.pid} ${w.width}x${w.height} @${w.x},${w.y}${w.minimized ? ' minimized' : ''}${w.foreground ? ' foreground' : ''}  "${w.title}"`);
  }
  if (windows.length === 0) {
    console.log('no Studio window to capture');
  }
  for (let i = 1; i <= count; i += 1) {
    t0 = performance.now();
    const r = await captureStudio({ format, maxWidth, titleMatch });
    console.log(`capture ${i}: ${r.width}x${r.height} ${r.mimeType} ${r.bytes} bytes; worker ${r.captured_ms} ms, round trip ${ms(t0)} ms, base64 ${r.base64.length} chars`);
    console.log(`  ${r.path}  ("${r.windowTitle}", hwnd ${r.hwnd})`);
  }
} catch (err) {
  console.error(`capture-smoke: ${err?.code ?? 'error'}: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  await shutdownCaptureWorker();
}
