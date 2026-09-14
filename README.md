<div align="center">

# Studio Live

**Real-time Roblox Studio for AI agents.** One MCP server, nine tools, an agent runtime that lives *inside* Studio.

[![CI](https://github.com/gurmyd/roblox-studio-live/actions/workflows/ci.yml/badge.svg)](https://github.com/gurmyd/roblox-studio-live/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-8A2BE2.svg)](https://modelcontextprotocol.io)

[Install](#install) · [Quick start](#quick-start) · [Tools](#tools) · [Works with](#works-with-any-mcp-client) · [Docs](#documentation) · [Security](#security)

</div>

Studio Live connects an AI coding agent to a running Roblox Studio over a single WebSocket. Instead of one tool call per property, the agent ships whole Luau *programs* against a resident API, gets errors and assertions *pushed* into its context, keeps playtests alive while it hot-patches code, reaches Open Cloud for the open place, and asks a vision sidecar visual questions that come back as text.

- **Fast where it matters** — 16 ms round trip (one Heartbeat frame), a hot-patch in a live playtest in ~17 ms, screenshots in ~30 ms even while Studio is minimised. Every number is measured; see [Why it feels fast](#why-it-feels-fast).
- **One undo step per program** — an edit-DataModel `run` is one Ctrl+Z for the human and rolls back on error.
- **Push, not poll** — errors, assertions, milestones, playtest, peer and job events arrive as they happen.
- **Playtests stay up** — install controllers that run at Heartbeat in-engine, hot-patch scripts, push instances, `run_until` a predicate — no stop/start per change.
- **Multi-agent, multi-Studio** — several agents share one Studio with FIFO writes; several Studio windows (server + N clients) form a multiplayer playtest.
- **Geometry is enforced** — overlapping parts and "parts in parts" are detected on every edit and can be rejected outright.
- **Any MCP client** — Claude Code, Codex CLI, Cursor, Claude Desktop, or a plain shell.

The design record is in [docs/architecture.md](docs/architecture.md), the wire contract in [docs/protocol.md](docs/protocol.md), the engine measurements it rests on in [docs/live-measurements.md](docs/live-measurements.md). Agents should read [docs/agent-guide.md](docs/agent-guide.md); the `cloud` and `look` tools have their own pages, [docs/cloud.md](docs/cloud.md) and [docs/vision.md](docs/vision.md).

## Works with any MCP client

It is a plain stdio MCP server. Nothing in the plugin, the protocol or the tools is tied to one client; only the way pushed events reach the model differs.

| Client | Tool calls | Push events | `look` (vision) |
|---|---|---|---|
| **Claude Code** | stdio MCP (`claude mcp add …`) | its `Monitor` tool subscribes to `ws://127.0.0.1:47800/events` | Anthropic API credential, **or** your Claude Code login |
| **Codex CLI · Cursor · Claude Desktop · any MCP client** | stdio MCP | the `events` tool (long-poll), or subscribe to `/events` yourself | Anthropic API credential, or a `claude` CLI on PATH |
| **Shell, scripts, other agents** | `studio-live call <tool>` or `POST /rpc` | `/events` WebSocket | same |

Several clients can run at once — the first bridge owns Studio, later ones proxy through it automatically. `look` is the one tool with a model behind it and today it only speaks to Anthropic models (the backend is the `VisionProvider` interface in `bridge/src/vision/types.ts`). Everything else works with no AI-vendor credential at all.

## Why it feels fast

Every number below was measured on one machine (Studio 0.738, Windows 11); see [docs/live-measurements.md](docs/live-measurements.md).

| Cost | Existing connectors | Studio Live | Measured |
|---|---|---|---|
| Transport wait per hop | community plugin polls every 0.5 s: mean **250 ms**, worst 500 ms, 2 req/s dispatch | one persistent WebSocket, push both ways | echo RTT **p50 16.5 ms**, max 17.7 ms (= one Heartbeat frame); 200 requests fired in one frame all answered in the next |
| Changing code in a playtest | stop → edit → start ≈ **2.7 s** plus two LLM turns | the playtest stays up; `Script.Source` written + `Disabled` toggled | hot-injected Script/LocalScript ran within **16.6 / 16.9 ms** |
| Screenshot | in-engine `CaptureService`: **649 / 592 ms** (≈1.5 fps), never fires while minimized | Win32 `PrintWindow` on the Studio HWND from the bridge | **28–44 ms** for 1734×1399, works while occluded; ≈100 ms round trip including bicubic resize to 1024 px and JPEG |
| Structured observation | one tree read or screenshot per LLM turn | pushed events + `diff` since a cursor | full 2 381-instance snapshot: walk 2.6 ms + JSON 0.55 ms = 114 KB |
| LLM turns per task | 2–10 s **per micro-tool**, ten tools for "walk to the door and try it" | one turn ships a Luau *program* or a *controller* that runs at Heartbeat in-engine | the turn itself cannot be removed, only the count |

The turn is the real cost, so the design (1) moves closed loops into Studio (controllers, `run_until` predicates, in-engine assertions), (2) makes each turn do more (programs against a resident `S` API, saved skills), and (3) streams observations to the agent instead of making it ask.

## Requirements

- **Windows 10/11.** The bridge and the plugin are platform-neutral Node and Luau, but the screenshot worker is Win32 (`PrintWindow`) and `install` / `twin` look up Windows paths, so macOS is not supported yet.
- **Node.js ≥ 20.**
- **Roblox Studio** with *Load User Plugins In Run Modes* on (File → Studio Settings → Studio).
- Optional: an Anthropic credential or a Claude Code login for `look`; a Roblox Open Cloud API key for `cloud`.

## Install

Full walkthrough with the reasons behind each step: [docs/install.md](docs/install.md).

```powershell
git clone https://github.com/gurmyd/roblox-studio-live.git
cd roblox-studio-live
npm install
npm run build            # tsc + copy worker.ps1 into dist + pack plugin/bootstrap.luau -> dist/StudioLive.rbxmx
npm run install:studio   # copies the plugin into %LOCALAPPDATA%\Roblox\Plugins and prints the next steps
```

Then, **once**: restart Roblox Studio. The edit DataModel loads plugin files only at start; after that the runtime is pushed by the bridge on every connect, so updating this package never needs another restart.

### Claude Code

The install step prints the exact line with the absolute path:

```powershell
claude mcp add studio -- node "<absolute path>\dist\bridge\cli.js" serve
```

Recommended `.claude/settings.json`, so tool calls and the push monitor run without prompts:

```json
{ "permissions": { "allow": ["mcp__studio__*", "Monitor"] } }
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.studio]
command = "node"
args = ["C:\\path\\to\\roblox-studio-live\\dist\\bridge\\cli.js", "serve"]
# tool calls longer than Codex's tool timeout return a job handle; use job { action: "wait" }
```

### Cursor / Claude Desktop / other JSON-configured clients

```json
{ "mcpServers": { "studio": { "command": "node", "args": ["C:\\path\\to\\roblox-studio-live\\dist\\bridge\\cli.js", "serve"] } } }
```

## Quick start

In a Claude Code session with Studio open on a place:

1. Arm push once — events then arrive in context without asking:
   `Monitor({ ws: { url: 'ws://127.0.0.1:47800/events' }, persistent: true })`
   (other clients: call `events { since: 0, timeout_ms: 25000 }` when you want a batch)
2. `observe { what: "status" }` — confirms the hub is connected, which DataModels are alive, capabilities.
3. `run { dm: "edit", undo_label: "agent: first part", code: "return S.path(S.part{ Name='Hello', Size=Vector3.new(4,1,4), CFrame=CFrame.new(0,3,0) })" }` — one undo step the human can Ctrl+Z.
4. `playtest { action: "start", mode: "play" }`, then `playtest { action: "install", dm: "client:1", name: "walker", code: "<controller>" }` — the controller plays and reports assertions as events while you keep editing.

Worked examples for every acceptance test (T1–T4) are in [docs/agent-guide.md](docs/agent-guide.md). A record of six agents building a playable game concurrently through the bridge is in [docs/multi-agent-build-report.md](docs/multi-agent-build-report.md).

## Tools

| Tool | Purpose |
|---|---|
| `run` | Execute a Luau program against the resident `S` API in `edit` (one undo step, rolled back on error) or `server`/`client:N` (ephemeral). `code` or `code_file` (the bridge reads the file — no shell/JSON escaping touches Luau). Returns value, captured output, change counts, duration, plus `warnings` (a `:Destroy(` call in an edit-DM program is not undoable) and `unwritable` (properties the plugin VM cannot set). |
| `observe` | Read-only: `status`, `tree` (an explicit `root` is always returned, `n: 0` when empty), `props`, `find`, `diff` (since cursor), `logs` (`dm: "all"` merges every DataModel; play-DM startup prints have real seqs), `script` (`path`, `from`, `to` line ranges), `stats`, `selection`, `player`, `screenshot`, `windows`, `geometry`, `selftest`. |
| `playtest` | `start` (`play` / `run` / `multiplayer` with `players` client Studios) / `stop` / `status` / `add_players`; `run_until` (predicate evaluated in-engine; `predicate_file`); `install`/`uninstall`/`list` controllers (`code_file`; `persist: true` is stored by the bridge on disk and re-installed on every peer hello — survives runtime, bridge and Studio restarts; an unsaved place, placeId 0, is memory-only); `hotpatch` a script's source in a live DataModel (`source_file`); `push` edit-DM instances into the live test (`replace` default true: a same-named, same-class sibling at the target is removed first, `replaced: n`; Terrain, the camera and player characters are never touched, `skipped`). |
| `input` | Human-like input sequences in the play client (keys, clicks, move, look, text, wait, focus; no scroll — an engine limit) through `UserInputService:CreateVirtualInput()`. |
| `events` | Long-poll backfill of the event journal (`since`, `kinds`, `timeout_ms ≤ 50000`) — the portable fallback to Monitor push. |
| `skills` | Luau program library on disk: `list`/`get`/`save` (`source_file`)/`delete`/`run`; eight read-only builtins ship with the bridge (`settle_physics`, `device_sim`, `profile_scripts`, `bulk_attributes`, `insert_asset`, `lighting_preset`, `list_scripts`, `remote_map`), overridable by name. |
| `job` | `status`/`cancel`/`wait`/`list` for long operations that returned a handle. |
| `cloud` | Roblox Open Cloud for the open place: `datastore` / `ordered` / `memory` / `message` / `info` / `publish` / `asset_upload` / `asset` / `luau` / `instance` / `restriction` / `notify`. `publish` makes a saved place file the live version; `luau` and `instance` act on that *published* place. `info what:"key"` reads what the API key may do — writes included — from Roblox's key introspection. Universe, place and creator ids default from the connected Studio session; the API key is read per call from `ROBLOX_OPEN_CLOUD_KEY` or `<STUDIO_LIVE_HOME>/opencloud.json` / `.key` ([docs/cloud.md](docs/cloud.md)). |
| `look` | Vision sidecar: `{question}` screenshots Studio and answers in **text** through a Claude vision model, so no image enters the agent's context; `{watch: {question, interval_s, stop_when}}` keeps capturing, skips unchanged frames and streams `vision` events to `/events`; `list` / `stop` ([docs/vision.md](docs/vision.md)). |

`observe`, `events` and `look` are annotated read-only so Claude Code runs them in parallel with other calls; `job` is not (`cancel` rolls back an edit-DM recording). `cloud` and `look` are the only tools that leave the machine (`openWorldHint`: Open Cloud, the Claude API). With two Studio windows connected, write tools require `session` and reads carry a `session_note`.

`look` reaches its vision model one of two ways. With an Anthropic API credential in the bridge's environment (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile) it calls the Claude API directly — about 2 s per look. Without one, a logged-in **Claude Code** install is enough: when `claude` is on the bridge's PATH the sidecar runs `claude -p --output-format json` per frame on your subscription (~10–15 s per look, watch interval at least 15 s, usage counted against your plan's limits rather than an API bill). `STUDIO_LIVE_VISION_PROVIDER = auto | api | claude-cli` chooses (default `auto`: the API when a credential resolves, else the CLI), and every answer and `vision` event names the `provider` that served it — see [docs/vision.md](docs/vision.md#using-your-claude-code-login-instead-of-an-api-key).

Programs in play DataModels get the same `S` API plus `S.ensure(path, class, props?)` (create-if-missing for roots shared between agents), `S.script.get(path, {from, to})` line ranges, and in controllers `ctx.pathTo(pos, timeout)` (PathfindingService) next to the straight-line `ctx.moveTo`. Several agents can share one Studio: edit-DM writes queue FIFO (no `busy` until 500 are waiting; measured live with 30 and 100 concurrent programs), and [docs/agent-guide.md](docs/agent-guide.md) has the multi-agent contract they follow.

**Geometry is enforced** ("parts in parts"): every edit-DM `run` checks the parts it added or moved through `S` for intersections with other parts (touching faces are fine) and for `Part`s parented under `Part`s, and reports them as `geometry` + `warnings`; `geometry_policy: "reject"` (or `STUDIO_LIVE_GEOMETRY_POLICY=reject`) rolls such a run back with `geometry_violation`, `observe { what: "geometry" }` audits any subtree, and `S.placeOn` / `S.fits` / `S.overlaps` make correct placement one line — see the agent guide's "Geometry rules (enforced)".

## Command line

Everything the tools do is also reachable from a shell through the running bridge (`POST /rpc`):

```powershell
studio-live serve                                   # the bridge + MCP server on stdio (what Claude Code launches)
studio-live install                                 # install the bootstrap plugin (STUDIO_LIVE_PORT baked in)
studio-live status                                  # GET /status of the running bridge (sessions, journal, jobs)
studio-live call <tool> [json | -] [--raw] [--port N] [--timeout ms]
studio-live call run --code-file .\build.luau --args-file .\build.args.json
studio-live call playtest '{"action":"hotpatch","dm":"server","path":"ServerScriptService.Main"}' --source-file .\Main.server.luau
studio-live call playtest '{"action":"run_until","dm":"server"}' --predicate-file .\ready.luau
studio-live sync <dir> [--pull] [--once] [--no-hotpatch] [--port N]
studio-live twin <place.rbxl> [--port N] [--timeout ms] [--exe C:\...\RobloxStudioBeta.exe]
```

- `call` performs one tool call and prints the tool's text (`--raw`: the whole MCP result JSON); exit code 1 when the result `isError` or no bridge answers. `--args-file <json>` supplies the whole argument object; `--code-file`, `--source-file`, `--predicate-file` read a Luau file (UTF-8, BOM stripped) into `code` / `source` / `predicate` — the supported way to hand Luau to the tools from scripts and subagents, because shell heredocs turn `\n` inside Luau strings into real newlines (the resulting `Malformed string` error says so).
- `sync` mirrors a folder of `.luau` files into the open place (or the place into the folder with `--pull`) — [docs/sync.md](docs/sync.md).
- `twin` launches a **second Roblox Studio** on a local place file (the newest `RobloxStudioBeta.exe` under `%LOCALAPPDATA%\Roblox\Versions\version-*\`, then a per-machine install under `%ProgramFiles(x86)%\Roblox\Versions`; `--exe <path>` or `STUDIO_LIVE_STUDIO_EXE` skips the scan; spawned detached with the `.rbxl` as its argument), waits up to 90 s (`--timeout ms`) for the new session to show up in `GET /status`, and prints its session id and place. A Studio that cannot start, or exits before connecting, is reported immediately (exit 1). **Multiple sessions:** each Studio process is its own session; while more than one is connected, pass `session: "<guid or unique prefix>"` on tool calls — reads default to the active session and say so (`session_note`), writes (`run`, `playtest`, `input`, `skills run`) refuse to guess. Naming a session once makes it the active one.

## Troubleshooting

**Screenshot fails with `minimized`.** `PrintWindow` cannot render a minimized window (Studio suspends its render loop). By default the bridge un-minimizes it *without taking focus* (`ShowWindow(SW_SHOWNOACTIVATE)` and a `SetWindowPos` to the bottom of the Z-order) and waits 400 ms; pass `restore: false` to refuse instead. A window that was maximized before being minimized comes back at its normal size — that is a Win32 limit of non-activating restores. Occluded windows capture fine; you do not need Studio in front.

**Screenshot fails with `no_window`.** No visible top-level window of a `RobloxStudioBeta` process has "Roblox Studio" in its title: Studio is not running, is still on the splash screen, or `title_match` did not match (the message lists the titles it saw). With several Studio processes the foreground one wins, else the topmost in Z-order; within a process the largest window wins (the main window over floating docks). `observe { what: "windows" }` lists them; pass `hwnd` from that list to pin one. The first screenshot after a bridge start can take a few seconds while the PowerShell worker compiles its Win32 shim; the bridge warms it up in the background and does not count that time against the 10 s capture timeout.

**`playtest start` says `no_peer`.** The play server/client DataModels never said hello. Open *File → Studio Settings → Studio* and turn **Load User Plugins In Run Modes** on (Faster Play Solo disables user plugins in test mode by default), and check that `StudioLive.rbxmx` is installed and Studio was restarted after installing it. `observe status` shows `peers` once they connect.

**Port 47800 is in use.** The bridge listens on `127.0.0.1:47800` (`STUDIO_LIVE_PORT` overrides; Studio connects to the literal `127.0.0.1`). A second MCP process on the same machine must not fight for the socket: it detects the primary and runs in **proxy mode**, forwarding tool calls over `POST /rpc` to the primary, which owns the single Studio connection; when the primary exits it first waits for jobs the proxy started, and the proxy then takes the port over on its next call. If the port is held by something else entirely, either free it or pick another: the plugin reads no settings, so set `STUDIO_LIVE_PORT` in the environment, run `npm run install:studio` again (it bakes the port into `StudioLive.rbxmx`), restart Studio once, and register the MCP server with `--env STUDIO_LIVE_PORT=<port>` (the install output prints the exact line).

**`syntax_error: Malformed string` on code that is valid Luau.** The program reached Studio with a real newline inside a quoted string: a shell heredoc or a JSON layer collapsed `\\n` to `\n` before the bridge saw it (the bridge itself is escape-clean — its selftest compiles `"\n"` and `"[^\n]+"` inside Luau strings). The error message appends the hint *"your transport turned \n into a newline — pass code from a file (code_file)"* when that is what happened. Write the program to a file and pass `code_file` / `source_file` / `predicate_file` (or `studio-live call --code-file`); never work around it with `string.char(10)`.

**Persisted controllers vanished after a restart / `playtest list` shows none.** Persistence lives in the bridge (`<STUDIO_LIVE_HOME>/persist/<placeId>.json`, default home `~/.studio-live`), not in Studio: `plugin:GetSetting` returns `nil` for every key on Studio 0.738. The bridge re-sends the list to the hub on every hello, so entries return when the bridge that stored them (or one sharing its home directory) is running; an entry is removed by `uninstall` or by a later install of the same name without `persist`. An unsaved place (`placeId` 0) has no file: its entries are memory-only and gone after a bridge restart. `persist_note` instead of `persist_file` on an install means the bridge could not write the file (read-only home, disk full) — the entry lives in memory for that bridge process only. Two Studios on the same `placeId` (a `twin`) share the file, which holds the union of both sessions' lists.

**Monitor is unavailable (Claude Code).** Monitor is gated off when `DISABLE_TELEMETRY` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, on Bedrock/Vertex/Foundry, in non-interactive runs, and in some clients. Use the `events` tool instead: `events { since: <last seq>, timeout_ms: 25000 }` long-polls the same journal, and a `PostToolBatch` hook can attach "events since cursor" to every tool round trip. Also call `events` whenever a pushed frame shows `dropped > 0` or a `seq` gap.

**Nothing happens after editing `plugin/bootstrap.luau`.** Studio does not load a newly written plugin file while running. Only the bootstrap lives on disk; iterate on runtime code through the bridge (pushed on connect) and restart Studio only when the bootstrap itself changes.

## Development

```powershell
npm run typecheck                 # tsc --noEmit
npm test                          # vitest (tests/**/*.test.ts); capture tests use a fake worker, no Studio needed
npm run build                     # dist/bridge/*.js + worker.ps1 + dist/StudioLive.rbxmx + dist/StudioLive.lua
npm run selftest                  # offline end-to-end: real bridge on a random port + scripts/fake-hub.mjs, PASS/FAIL per protocol check
npm run luau:check                # parse/type-check plugin/**/*.luau with luau-lsp (fetches Roblox definitions once)
npm run fake-hub -- --port 47800  # pretend to be Studio against a running bridge (handshake, events, canned answers)
node scripts/capture-smoke.mjs    # lists Studio windows and captures two frames with timings (Studio must be open)
```

Layout: `bridge/src` (Node bridge: MCP server, sessions, journal, jobs, skills, `capture/` worker, `cloud/`, `vision/`, `sync/`), `plugin/bootstrap.luau` (the only code installed into Studio) and `plugin/runtime/**` (the hub/agent runtime the bridge pushes on connect; see [docs/luau-runtime.md](docs/luau-runtime.md)), `skills/builtin` (Luau programs shipped with the bridge), `scripts/` (build, packaging, selftest, smoke), `docs/`, `tests/`.

The bridge's stdout is the MCP stdio transport; every log line goes to stderr. Screenshots land in `%TEMP%\studio-live\frames` (newest 200 kept). The rules that keep the live system working (the bootstrap is frozen, tests never bind 47800, keys are never printed) are in [AGENTS.md](AGENTS.md).

## Documentation

| Page | What it covers |
|---|---|
| [docs/agent-guide.md](docs/agent-guide.md) | How an agent should work with the tools: working style, worked examples, the multi-agent contract, geometry rules, `look` vs `observe` |
| [docs/architecture.md](docs/architecture.md) | The design record: what was built and why |
| [docs/protocol.md](docs/protocol.md) | The wire contract between bridge and plugin: bootstrap, ops, events, the `S` API, value serialization |
| [docs/luau-runtime.md](docs/luau-runtime.md) | The in-Studio runtime that the bridge pushes on every connect |
| [docs/install.md](docs/install.md) | Install walkthrough with the reason behind each step |
| [docs/cloud.md](docs/cloud.md) | The `cloud` tool: Open Cloud actions, permissions, key setup |
| [docs/vision.md](docs/vision.md) | The `look` tool: providers, watch mode, costs |
| [docs/sync.md](docs/sync.md) | `studio-live sync`: mirroring `.luau` files into and out of a place |
| [docs/live-measurements.md](docs/live-measurements.md) | Engine measurements on Studio 0.738 the design rests on |
| [docs/live-test-results.md](docs/live-test-results.md) | Acceptance-test results against a live Studio, defects found and fixed |
| [docs/multi-agent-build-report.md](docs/multi-agent-build-report.md) | Six agents building a playable game concurrently through the bridge |
| [docs/research-brief.md](docs/research-brief.md) | The architecture brief that preceded the build: what a connector can and cannot make fast |

## Security

The bridge listens on `127.0.0.1` only and has no authentication: any process on your machine can drive Studio through it, and the plugin runs whatever bundle the bridge sends it. Only `look` (a screenshot to the Anthropic API) and `cloud` (your request to Open Cloud) leave the machine. API keys are read from the environment or `~/.studio-live`, never returned by a tool, and masked in logs. Nothing saves or publishes a place on its own: `cloud publish` makes a place file the live version and `cloud restriction ban` bans players, but only when an agent calls them, and only with a key granted those permissions. Give an agent's key no more than its work needs — `cloud { action: "info", what: "key" }` shows what it has.

## License

[MIT](LICENSE). Not affiliated with Roblox Corporation.
