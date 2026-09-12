// Stand-in for worker.ps1: speaks the same one-JSON-line-per-command protocol without Win32.
// Behaviour is selected by cmd so the tests can exercise framing, timeouts and restarts.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const reply = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// Smallest valid JPEG-ish payload we need: the client only reads bytes and base64-encodes them.
const FAKE_IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

const rl = createInterface({ input: process.stdin });
process.stderr.write(`fake worker ready pid=${process.pid}\n`);

rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  switch (req.cmd) {
    case 'ping':
      reply({ id: req.id, ok: true, pong: true, pid: process.pid });
      return;
    case 'echo':
      reply({ id: req.id, ok: true, echo: req });
      return;
    case 'sleep':
      setTimeout(() => reply({ id: req.id, ok: true, slept: req.ms }), req.ms);
      return;
    case 'noreply':
      return;
    case 'garbage':
      process.stdout.write('this is not json\n{"ok":true}\n');
      reply({ id: req.id, ok: true, after: 'garbage' });
      return;
    case 'unicode':
      reply({ id: req.id, ok: true, text: 'PIRATES — Roblox Studio ✓ 日本語' });
      return;
    case 'crash':
      process.stdout.write('{"id":"partial');
      process.exit(3);
      return;
    case 'fail':
      reply({ id: req.id, ok: false, code: req.code, message: req.message });
      return;
    case 'list':
      reply({
        id: req.id,
        ok: true,
        windows: [
          { hwnd: '134302', pid: 38556, title: 'PIRATES - Roblox Studio', rect: { x: 1713, y: 0, width: 1734, height: 1399 }, minimized: false, foreground: false },
          { hwnd: '9001', pid: 38556, title: 'Explorer - Roblox Studio', rect: { x: 0, y: 0, width: 300, height: 600 }, minimized: true, foreground: false },
        ],
      });
      return;
    case 'capture': {
      if (req.titleMatch === 'nomatch') {
        reply({ id: req.id, ok: false, code: 'no_window', message: `no Roblox Studio window title contains '${req.titleMatch}'` });
        return;
      }
      if (req.titleMatch === 'weird-code') {
        reply({ id: req.id, ok: false, code: 'something_new', message: 'a code the client does not know' });
        return;
      }
      if (req.titleMatch === 'malformed') {
        reply({ id: req.id, ok: true, path: 42 });
        return;
      }
      if (req.hwnd === '777' && req.restore === false) {
        reply({ id: req.id, ok: false, code: 'minimized', message: 'window is minimized' });
        return;
      }
      if (req.format === 'png' && req.region && req.region.x > 5000) {
        reply({ id: req.id, ok: false, code: 'capture_failed', message: 'region lies outside the window' });
        return;
      }
      writeFileSync(req.outPath, FAKE_IMAGE);
      reply({
        id: req.id,
        ok: true,
        path: req.outPath,
        width: Math.min(req.maxWidth || 1734, 1734),
        height: 826,
        source: { width: 1734, height: 1399 },
        bytes: FAKE_IMAGE.length,
        ms: 41.5,
        title: 'PIRATES - Roblox Studio',
        hwnd: req.hwnd || '134302',
        pid: 38556,
        echo: req,
      });
      return;
    }
    case 'restore':
      if (req.hwnd === '1') reply({ id: req.id, ok: false, code: 'no_window', message: 'hwnd 1 is not a window' });
      else reply({ id: req.id, ok: true, hwnd: req.hwnd, minimized: false });
      return;
    default:
      reply({ id: req.id, ok: false, code: 'bad_request', message: `unknown cmd '${req.cmd}'` });
  }
});

rl.on('close', () => process.exit(0));
