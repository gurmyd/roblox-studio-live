import { spawn } from 'node:child_process';
import http from 'node:http';
import fsp from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createBridge, type Bridge } from '../../bridge/src/app.js';
import {
  exeFlag,
  findStudioExecutable,
  intFlag,
  parseFlags,
  portFlag,
  readCallArgs,
  readToolArgs,
  renderCallResult,
  runCall,
  runSync,
  runTwin,
  timeoutFlag,
  type CommandIo,
  type StudioLaunch,
  type SyncHandle,
  type SyncOptions,
} from '../../bridge/src/commands.js';
import { loadConfig, PACKAGE_ROOT } from '../../bridge/src/config.js';
import { silentLogger } from '../../bridge/src/log.js';
import type { CaptureApi } from '../../bridge/src/tools.js';

const capture: CaptureApi = {
  captureStudio: async () => {
    throw Object.assign(new Error('no capture in tests'), { code: 'no_window' });
  },
};

interface FakeIo extends CommandIo {
  out: string[];
  err: string[];
}

function fakeIo(stdin = '', stdinIsTty = true): FakeIo {
  const io: FakeIo = {
    out: [],
    err: [],
    stdout: (text) => {
      io.out.push(text);
    },
    stderr: (text) => {
      io.err.push(text);
    },
    readStdin: async () => stdin,
    stdinIsTty,
  };
  return io;
}

/** A port nothing listens on: bind, read the number, close. */
async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('argument parsing', () => {
  it('splits positionals from --flags, --flag=value and value-taking flags', () => {
    const parsed = parseFlags(['skills', '{"action":"list"}', '--raw', '--port', '4711', '--timeout=5000', '--once', '--pull']);
    expect(parsed.positional).toEqual(['skills', '{"action":"list"}']);
    expect([...parsed.flags.entries()]).toEqual([
      ['raw', true],
      ['port', '4711'],
      ['timeout', '5000'],
      ['once', true],
      ['pull', true],
    ]);
    expect(portFlag(parsed.flags, 1)).toBe(4711);
    expect(portFlag(new Map(), 47800)).toBe(47800);
    expect(() => portFlag(new Map([['port', 'abc']]), 1)).toThrowError(/--port/);
    // A bare --port before another flag does not swallow it.
    expect(parseFlags(['sync', 'dir', '--port', '--once']).flags.get('once')).toBe(true);
    // --timeout is validated like --port instead of silently falling back to the default.
    expect(timeoutFlag(parsed.flags)).toBe(5000);
    expect(timeoutFlag(new Map())).toBeUndefined();
    for (const bad of ['120s', '0', '-5', '1.5', 'abc']) expect(() => timeoutFlag(new Map([['timeout', bad]])), bad).toThrowError(/--timeout must be an integer in 1\.\.3600000/);
    expect(intFlag(new Map([['n', '7']]), 'n', 1, 1, 10)).toBe(7);
    expect(intFlag(new Map([['n', true]]), 'n', 1, 1, 10)).toBe(1);
    expect(() => intFlag(new Map([['n', '11']]), 'n', 1, 1, 10)).toThrowError(/--n must be an integer in 1\.\.10, got "11"/);
    expect(exeFlag(new Map())).toBeUndefined();
    expect(exeFlag(new Map([['exe', 'C:\\Studio\\RobloxStudioBeta.exe']]))).toBe('C:\\Studio\\RobloxStudioBeta.exe');
    expect(() => exeFlag(new Map([['exe', true]]))).toThrowError(/--exe needs a path/);
  });

  it('reads tool args from the literal, from stdin, or defaults to {}', async () => {
    expect(await readToolArgs('{"what":"status"}', fakeIo())).toEqual({ what: 'status' });
    expect(await readToolArgs(undefined, fakeIo())).toEqual({});
    expect(await readToolArgs(undefined, fakeIo('{"since": 3}', false))).toEqual({ since: 3 });
    expect(await readToolArgs('-', fakeIo(' {"a":1} \n'))).toEqual({ a: 1 });
    expect(await readToolArgs('-', fakeIo(''))).toEqual({});
    await expect(readToolArgs('[1]', fakeIo())).rejects.toMatchObject({ code: 'bad_request' });
    await expect(readToolArgs('{oops', fakeIo())).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('does not hang on a piped stdin that nobody writes to or closes', async () => {
    // A wrapper spawned `studio-live call skills` with stdio 'pipe' and forgot stdin: proceed with {} after the idle wait.
    const silent = fakeIo('', false);
    silent.readStdin = () => new Promise<string>(() => undefined);
    const t0 = Date.now();
    expect(await readToolArgs(undefined, silent, 40)).toEqual({});
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(silent.err.join('')).toMatch(/no tool arguments on stdin after 40 ms; calling with \{\}/);
    // Bytes already flowing (a slow producer): keep waiting for EOF instead of giving up.
    const slow = fakeIo('', false);
    slow.stdinDataSeen = () => true;
    slow.readStdin = () => new Promise<string>((resolve) => setTimeout(() => resolve('{"slow": true}'), 90));
    expect(await readToolArgs(undefined, slow, 20)).toEqual({ slow: true });
    expect(slow.err).toEqual([]);
    // An explicit "-" always waits for EOF.
    const explicit = fakeIo('', false);
    explicit.readStdin = () => new Promise<string>((resolve) => setTimeout(() => resolve('{"x":1}'), 60));
    expect(await readToolArgs('-', explicit, 10)).toEqual({ x: 1 });
  });

  it('merges --args-file and turns --code-file / --source-file / --predicate-file into absolute *_file arguments', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-callargs-'));
    try {
      await fsp.writeFile(path.join(dir, 'args.json'), '\uFEFF{"dm":"server","args":{"n":2}}', 'utf8');
      const parsed = parseFlags(['run', '{"code":"inline","timeout_ms":5000}', '--args-file', path.join(dir, 'args.json'), '--code-file', 'build.luau', '--source-file=src.luau', '--predicate-file', 'pred.luau', '--raw']);
      expect(parsed.positional).toEqual(['run', '{"code":"inline","timeout_ms":5000}']);
      expect(parsed.flags.get('code-file')).toBe('build.luau');
      expect(parsed.flags.get('raw')).toBe(true);
      const args = await readCallArgs(parsed.positional[1], parsed.flags, fakeIo());
      expect(args).toEqual({
        timeout_ms: 5000,
        dm: 'server',
        args: { n: 2 },
        code_file: path.resolve('build.luau'),
        source_file: path.resolve('src.luau'),
        predicate_file: path.resolve('pred.luau'),
      });
      // --args-file (or any *-file flag) without a literal never waits on stdin; a bad file is refused up front.
      const piped = fakeIo('', false);
      piped.readStdin = () => new Promise<string>(() => undefined);
      expect(await readCallArgs(undefined, new Map([['args-file', path.join(dir, 'args.json')]]), piped, 10)).toEqual({ dm: 'server', args: { n: 2 } });
      expect(await readCallArgs(undefined, new Map([['code-file', 'x.luau']]), piped, 10)).toEqual({ code_file: path.resolve('x.luau') });
      expect(piped.err).toEqual([]);
      await expect(readCallArgs(undefined, new Map([['args-file', path.join(dir, 'missing.json')]]), fakeIo())).rejects.toMatchObject({ code: 'bad_request' });
      await fsp.writeFile(path.join(dir, 'list.json'), '[1]', 'utf8');
      await expect(readCallArgs(undefined, new Map([['args-file', path.join(dir, 'list.json')]]), fakeIo())).rejects.toMatchObject({ code: 'bad_request', message: /JSON object/ });
      await expect(readCallArgs(undefined, new Map([['code-file', true]]), fakeIo())).rejects.toMatchObject({ code: 'bad_request', message: /needs a path/ });
      expect(await readCallArgs('{"what":"status"}', new Map(), fakeIo())).toEqual({ what: 'status' });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('finds the newest Studio build under Roblox\\Versions', async () => {
    const versions = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-versions-'));
    try {
      expect(await findStudioExecutable(path.join(versions, 'nope'))).toBeNull();
      expect(await findStudioExecutable(versions)).toBeNull();
      const old = path.join(versions, 'version-old');
      const player = path.join(versions, 'version-player');
      const fresh = path.join(versions, 'version-new');
      await fsp.mkdir(old);
      await fsp.mkdir(player);
      await fsp.mkdir(fresh);
      await fsp.writeFile(path.join(old, 'RobloxStudioBeta.exe'), 'x');
      await fsp.writeFile(path.join(player, 'RobloxPlayerBeta.exe'), 'x');
      await fsp.writeFile(path.join(fresh, 'RobloxStudioBeta.exe'), 'x');
      const past = new Date(Date.now() - 86_400_000);
      await fsp.utimes(path.join(old, 'RobloxStudioBeta.exe'), past, past);
      await fsp.utimes(old, past, past);
      expect(await findStudioExecutable(versions)).toBe(path.join(fresh, 'RobloxStudioBeta.exe'));
      // Several Versions folders (per-user, then per-machine installs) are scanned; missing ones are skipped.
      expect(await findStudioExecutable([path.join(versions, 'nope'), versions])).toBe(path.join(fresh, 'RobloxStudioBeta.exe'));
      // An explicit executable (--exe / STUDIO_LIVE_STUDIO_EXE) wins when it exists and is otherwise "not found".
      expect(await findStudioExecutable(versions, path.join(old, 'RobloxStudioBeta.exe'))).toBe(path.join(old, 'RobloxStudioBeta.exe'));
      expect(await findStudioExecutable(versions, path.join(versions, 'missing.exe'))).toBeNull();
      expect(await findStudioExecutable(versions, old)).toBeNull();
    } finally {
      await fsp.rm(versions, { recursive: true, force: true });
    }
  });

  it('renders text parts verbatim and images as a placeholder', () => {
    expect(renderCallResult({ content: [{ type: 'text', text: '{"a":1}' }] })).toBe('{"a":1}');
    const rendered = renderCallResult({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'meta' }] });
    expect(rendered).toMatch(/^\[image image\/png, 3 bytes base64; use --raw for the data\]\nmeta$/);
  });
});

describe('studio-live call against an in-process bridge', () => {
  let home: string;
  let bridge: Bridge;
  let port: number;

  beforeAll(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-cli-test-'));
    bridge = await createBridge({ ...loadConfig({ STUDIO_LIVE_HOME: home }), port: 0 }, silentLogger, { capture });
    if (bridge.mode !== 'primary') throw new Error('expected primary');
    port = bridge.port;
  });

  afterAll(async () => {
    await bridge.close();
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('prints the tool text and exits 0; builtin skills are visible through it', async () => {
    const io = fakeIo();
    const code = await runCall({ port, tool: 'skills', args: { action: 'list' }, raw: false }, io);
    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    const printed = JSON.parse(io.out.join('')) as { builtin_dir: string; skills: Array<{ name: string; builtin: boolean; params: unknown }> };
    expect(printed.builtin_dir).toBe(path.join(loadConfig().packageRoot, 'skills', 'builtin'));
    const builtins = printed.skills.filter((s) => s.builtin).map((s) => s.name);
    expect(builtins).toEqual(expect.arrayContaining(['settle_physics', 'device_sim', 'profile_scripts', 'bulk_attributes', 'insert_asset', 'lighting_preset', 'list_scripts', 'remote_map']));
    expect(printed.skills.find((s) => s.name === 'settle_physics')?.params).toMatchObject({ seconds: expect.anything() });
  });

  it('exits 1 on a tool error and prints the error payload; --raw prints the MCP result', async () => {
    const io = fakeIo();
    expect(await runCall({ port, tool: 'run', args: { code: 'return 1' }, raw: false }, io)).toBe(1);
    expect(JSON.parse(io.out.join(''))).toMatchObject({ error: { code: 'no_session' } });

    const raw = fakeIo();
    expect(await runCall({ port, tool: 'job', args: { action: 'list' }, raw: true }, raw)).toBe(0);
    expect(JSON.parse(raw.out.join(''))).toEqual({ content: [{ type: 'text', text: expect.stringContaining('"jobs"') }] });

    const invalid = fakeIo();
    expect(await runCall({ port, tool: 'nope', args: {}, raw: false }, invalid)).toBe(1);
    expect(JSON.parse(invalid.out.join(''))).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('fails clearly when no bridge answers on the port', async () => {
    const io = fakeIo();
    expect(await runCall({ port: await freePort(), tool: 'observe', args: { what: 'status' }, raw: false }, io)).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err.join('')).toMatch(/no studio-live bridge on port \d+/);
  });

  it('exits as a process even when stdin is a pipe nobody writes to or closes', async () => {
    // A wrapper's default stdio ('pipe') used to keep the event loop alive through the stdin listener
    // after the call was answered, so the exit code (1 on isError / no bridge) never reached it.
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(PACKAGE_ROOT, 'bridge', 'src', 'cli.ts'), 'call', 'observe', '--port', String(await freePort())], {
      cwd: PACKAGE_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, STUDIO_LIVE_HOME: home },
    });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number | null | 'hang'>((resolve) => {
      const guard = setTimeout(() => {
        child.kill();
        resolve('hang');
      }, 15_000);
      child.once('exit', (exitCode) => {
        clearTimeout(guard);
        resolve(exitCode);
      });
    });
    expect(code, Buffer.concat(stderr).toString('utf8')).toBe(1);
    expect(Buffer.concat(stderr).toString('utf8')).toMatch(/no tool arguments on stdin after 750 ms[\s\S]*no studio-live bridge on port/);
  });

  it('twin launches Studio on a place file and reports the session that appears on the bridge', async () => {
    const place = path.join(home, 'twin.rbxl');
    await fsp.writeFile(place, 'not really a place', 'utf8');
    const twinSession = 'ab12ab12-0000-4000-8000-00000000aa11';
    let hub: WebSocket | null = null;
    const launched: Array<{ exe: string; place: string }> = [];
    const never = new Promise<number | null>(() => undefined);
    const spawnStudio = async (exe: string, file: string): Promise<StudioLaunch> => {
      launched.push({ exe, place: file });
      // The launched Studio's bootstrap hellos the bridge a moment later.
      setTimeout(() => {
        hub = new WebSocket(`ws://127.0.0.1:${port}/studio`);
        hub.once('open', () => {
          hub!.send(JSON.stringify({ v: 1, kind: 'hello', proto: 1, bootstrap: '1.0.0', role: 'edit', session: twinSession, studio: { placeId: 0, placeName: 'twin', dataModelName: 'twin' }, lastSeq: 0 }));
        });
      }, 40);
      return { pid: 4242, exited: never };
    };
    const io = fakeIo();
    try {
      const code = await runTwin({ place, port, waitMs: 5000, pollMs: 25 }, io, { findStudio: async () => 'C:\\fake\\RobloxStudioBeta.exe', spawnStudio });
      expect(code).toBe(0);
      expect(launched).toEqual([{ exe: 'C:\\fake\\RobloxStudioBeta.exe', place }]);
      expect(io.err.join('')).toMatch(/launched C:\\fake\\RobloxStudioBeta\.exe .*pid 4242/);
      expect(JSON.parse(io.out.join(''))).toMatchObject({ session: twinSession, place: 'twin', placeId: 0, pid: 4242, note: expect.stringMatching(/session=/) });

      // No Studio found, a missing / non-place file, a timeout and no bridge are all reported with distinct exit codes.
      const noStudio = fakeIo();
      expect(await runTwin({ place, port, waitMs: 200, pollMs: 25 }, noStudio, { findStudio: async () => null, spawnStudio })).toBe(1);
      expect(noStudio.err.join('')).toMatch(/Roblox Studio not found: no version-\*.*pass --exe/);
      // An explicit executable reaches the finder and is named when it is missing.
      const seen: Array<string | undefined> = [];
      const badExe = fakeIo();
      expect(await runTwin({ place, port, waitMs: 200, pollMs: 25, exe: 'C:\\nope\\Studio.exe' }, badExe, { findStudio: async (override) => (seen.push(override), null), spawnStudio })).toBe(1);
      expect(seen).toEqual(['C:\\nope\\Studio.exe']);
      expect(badExe.err.join('')).toMatch(/Roblox Studio not found: C:\\nope\\Studio\.exe \(from --exe\)/);
      const badFile = fakeIo();
      expect(await runTwin({ place: path.join(home, 'nope.rbxl'), port, waitMs: 200, pollMs: 25 }, badFile, { findStudio: async () => 'x', spawnStudio })).toBe(2);
      expect(badFile.err.join('')).toMatch(/place file not found/);
      expect(await runTwin({ place: path.join(home, 'twin.txt'), port, waitMs: 200, pollMs: 25 }, fakeIo(), { findStudio: async () => 'x', spawnStudio })).toBe(2);
      const timeout = fakeIo();
      expect(await runTwin({ place, port, waitMs: 120, pollMs: 25 }, timeout, { findStudio: async () => 'x', spawnStudio: async () => ({ pid: undefined, exited: never }) })).toBe(1);
      expect(timeout.err.join('')).toMatch(/no new Studio session connected within/);
      // A launch that cannot start (EACCES, a stale version folder) is reported at once, not after the wait.
      const cannotStart = fakeIo();
      const t0 = Date.now();
      expect(
        await runTwin({ place, port, waitMs: 5000, pollMs: 25 }, cannotStart, {
          findStudio: async () => 'x',
          spawnStudio: async () => {
            throw Object.assign(new Error('spawn x EACCES'), { code: 'EACCES' });
          },
        }),
      ).toBe(1);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(cannotStart.err.join('')).toMatch(/could not start x: spawn x EACCES/);
      // A Studio that exits before connecting ends the wait early with its exit code.
      const died = fakeIo();
      expect(await runTwin({ place, port, waitMs: 5000, pollMs: 25 }, died, { findStudio: async () => 'x', spawnStudio: async () => ({ pid: 7, exited: Promise.resolve(3) }) })).toBe(1);
      expect(died.err.join('')).toMatch(/Studio exited with code 3 before its session connected/);
      const noBridge = fakeIo();
      expect(await runTwin({ place, port: await freePort(), waitMs: 100, pollMs: 25 }, noBridge, { findStudio: async () => 'x', spawnStudio })).toBe(1);
      expect(noBridge.err.join('')).toMatch(/no studio-live bridge/);
      // Only the successful run reached the launcher: every refusal happens before Studio is spawned.
      expect(launched).toHaveLength(1);
    } finally {
      (hub as WebSocket | null)?.close();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  });

  it('sync drives startSync with the CLI options and prints its stats', async () => {
    const calls: SyncOptions[] = [];
    let stopped = 0;
    const handle: SyncHandle = {
      stop: async () => {
        stopped += 1;
      },
      stats: () => ({ pushed: 3, pulled: 1, errors: 0, lastEvent: 'pushed ServerScriptService/Main.server.luau' }),
    };
    const loadStartSync = async () => async (opts: SyncOptions) => {
      calls.push(opts);
      opts.log?.('watching');
      return handle;
    };

    const once = fakeIo();
    const dir = path.join(home, 'src');
    expect(await runSync({ dir, port, pull: true, once: true, hotpatch: true }, once, { loadStartSync })).toBe(0);
    expect(calls[0]).toMatchObject({ dir, port, pull: true, once: true, hotpatch: true });
    expect(typeof calls[0]?.log).toBe('function');
    expect(stopped).toBe(1);
    expect(once.err.join('')).toContain('watching');
    expect(JSON.parse(once.out.join(''))).toEqual({ pushed: 3, pulled: 1, errors: 0, lastEvent: 'pushed ServerScriptService/Main.server.luau' });

    // Continuous mode waits for the stop signal, then stops the handle; errors turn into exit 1.
    let waited = 0;
    const failing: SyncHandle = { stop: handle.stop, stats: () => ({ pushed: 0, pulled: 0, errors: 2 }) };
    const io = fakeIo();
    const code = await runSync(
      { dir, port, pull: false, once: false, hotpatch: false },
      io,
      {
        loadStartSync: async () => async (opts) => {
          calls.push(opts);
          return failing;
        },
        waitForStop: async () => {
          waited += 1;
        },
      },
    );
    expect(code).toBe(1);
    expect(waited).toBe(1);
    expect(stopped).toBe(2);
    expect(calls[1]).toMatchObject({ pull: false, once: false, hotpatch: false });
    expect(io.err.join('')).toMatch(/hotpatch off.*Ctrl\+C stops/);

    // Without a bridge the sync module is never loaded.
    let loaded = 0;
    const dead = fakeIo();
    expect(
      await runSync({ dir, port: await freePort(), pull: false, once: true, hotpatch: true }, dead, {
        loadStartSync: async () => {
          loaded += 1;
          return async () => handle;
        },
      }),
    ).toBe(1);
    expect(loaded).toBe(0);
    expect(dead.err.join('')).toMatch(/no studio-live bridge/);
  });
});
