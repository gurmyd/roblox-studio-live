#!/usr/bin/env node
import path from 'node:path';
import { serve } from './app.js';
import { exeFlag, parseFlags, portFlag, readCallArgs, runCall, runSync, runTwin, timeoutFlag, type CommandIo } from './commands.js';
import { loadConfig } from './config.js';
import { errorMessage } from './errors.js';
import { formatInstallReport, installPlugin } from './install.js';
import { probePrimary } from './proxy.js';

const USAGE = `studio-live — real-time Roblox Studio MCP bridge

Usage: studio-live [serve|install|status|call|sync|twin|help]

  serve                         start the bridge and the MCP server on stdio (default)
  install                       install the Studio bootstrap plugin (with STUDIO_LIVE_PORT baked in) and print the follow-up steps
  status                        print GET /status of the running bridge
  call <tool> [json-args]       call one tool on the running bridge over POST /rpc and print the result
                                json-args: a JSON object literal, "-" for stdin, or omitted when stdin is piped
                                --args-file f merges a JSON object file into the arguments
                                --code-file f | --source-file f | --predicate-file f pass Luau as code_file / source_file /
                                predicate_file (absolute paths the bridge reads: no shell or JSON escaping touches the Luau)
                                --raw prints the whole MCP result JSON; --port N overrides the port; exit 1 on a tool error
  sync <dir> [--pull] [--once]  mirror <dir>/**/*.luau into the open place (--pull mirrors Studio -> disk instead);
                                --once runs one pass and exits; --no-hotpatch stops pushed scripts from being hot-patched
                                into a running playtest (on by default); --port N overrides the port
  twin <place.rbxl>             launch a second Roblox Studio (newest version-*\\RobloxStudioBeta.exe under %LOCALAPPDATA%\\Roblox\\Versions,
                                then %ProgramFiles(x86)%\\Roblox\\Versions; --exe <path> or STUDIO_LIVE_STUDIO_EXE overrides) on a local
                                place file and wait up to 90 s for its session to connect; prints {session, place, placeId, pid}.
                                Pass session=<id> on tool calls to address it. --port N overrides the port; --timeout ms the wait

Environment:
  STUDIO_LIVE_PORT        bridge port (default 47800); set it for both "install" and "serve"
  STUDIO_LIVE_HOME        data directory (default ~/.studio-live)
  STUDIO_LIVE_DEV=1       watch plugin/runtime and push bundle changes to Studio
  STUDIO_LIVE_LOG         debug | info | warn | error (default info; always stderr)
  STUDIO_LIVE_GEOMETRY_POLICY  warn | reject | off (default warn): what an edit-DM run does about overlapping / nested
                          parts it created when the call gives no geometry_policy
  STUDIO_LIVE_STUDIO_EXE  RobloxStudioBeta.exe for "twin" (skips the Versions scan)
`;

let stdinDataSeen = false;

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => {
      stdinDataSeen = true;
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/**
 * A piped stdin that nobody writes to or closes (a wrapper's default stdio) keeps the event loop
 * alive through its `data` listener after the command is done: let go of it so the process exits
 * with the command's code instead of hanging.
 */
function releaseStdin(): void {
  try {
    if (process.stdin.isTTY) return;
    process.stdin.pause();
    process.stdin.destroy();
  } catch {
    // nothing to release
  }
}

const io: CommandIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  readStdin: readAllStdin,
  stdinIsTty: process.stdin.isTTY === true,
  stdinDataSeen: () => stdinDataSeen,
};

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0] ?? 'serve';
  switch (command) {
    case 'serve':
      await serve(loadConfig());
      return;
    case 'install': {
      const result = await installPlugin({ port: loadConfig().port });
      process.stdout.write(`${formatInstallReport(result)}\n`);
      return;
    }
    case 'status': {
      const config = loadConfig();
      const probe = await probePrimary(config.port);
      if (probe.state !== 'healthy') {
        process.stderr.write(`no studio-live bridge on port ${config.port} (${probe.detail})\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${JSON.stringify(probe.status.raw, null, 2)}\n`);
      return;
    }
    case 'call': {
      const { positional, flags } = parseFlags(argv.slice(1));
      const tool = positional[0];
      if (!tool) {
        process.stderr.write(`usage: studio-live call <tool> [json-args] [--args-file f] [--code-file f] [--source-file f] [--predicate-file f] [--raw] [--port N]\n`);
        process.exitCode = 2;
        return;
      }
      const timeoutMs = timeoutFlag(flags);
      const port = portFlag(flags, loadConfig().port);
      try {
        const args = await readCallArgs(positional[1], flags, io);
        process.exitCode = await runCall({ port, tool, args, raw: flags.get('raw') === true, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, io);
      } finally {
        releaseStdin();
      }
      return;
    }
    case 'sync': {
      const { positional, flags } = parseFlags(argv.slice(1));
      const dir = positional[0];
      if (!dir) {
        process.stderr.write(`usage: studio-live sync <dir> [--pull] [--once] [--no-hotpatch] [--port N]\n`);
        process.exitCode = 2;
        return;
      }
      process.exitCode = await runSync(
        {
          dir: path.resolve(dir),
          port: portFlag(flags, loadConfig().port),
          pull: flags.get('pull') === true,
          once: flags.get('once') === true,
          // Hot-patching pushed scripts into a live playtest is the sync module's default; --no-hotpatch opts out.
          hotpatch: flags.get('no-hotpatch') !== true,
        },
        io,
      );
      return;
    }
    case 'twin': {
      const { positional, flags } = parseFlags(argv.slice(1));
      const place = positional[0];
      if (!place) {
        process.stderr.write(`usage: studio-live twin <place.rbxl> [--port N] [--timeout ms] [--exe RobloxStudioBeta.exe]\n`);
        process.exitCode = 2;
        return;
      }
      const waitMs = timeoutFlag(flags);
      const exe = exeFlag(flags);
      try {
        process.exitCode = await runTwin(
          { place, port: portFlag(flags, loadConfig().port), ...(waitMs !== undefined ? { waitMs } : {}), ...(exe !== undefined ? { exe } : {}) },
          io,
        );
      } finally {
        releaseStdin();
      }
      return;
    }
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return;
    case '--version':
    case '-v':
      process.stdout.write(`${loadConfig().version}\n`);
      return;
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`studio-live: ${errorMessage(err)}\n`);
  process.exit(1);
});
