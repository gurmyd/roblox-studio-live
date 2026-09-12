# Script sync — Rojo-lite two-way sync between a directory and the open place

`bridge/src/sync` mirrors `.luau` files into the place Studio has open (push) or the place's scripts into files (pull). It is a **client of the bridge**: it only speaks `POST /rpc {tool, args}` on the bridge port (exactly like `scripts/rpc.mjs`), so it runs as a separate process next to a bridge that Claude Code started, and it works while the agent keeps using the tools. Nothing in it imports bridge internals.

Scope: scripts only (`Script`, `LocalScript`, `ModuleScript`) plus the `Folder`s they need. Properties, models, `.meta.json`, `.model.json`, `.rbxm(x)`, `.lua` and every other file type are out of scope — that is what real Rojo is for (see the last section).

## Commands

```powershell
node dist/bridge/sync/main.js <dir>                 # push: disk → Studio, watch for changes, hot-patch playtests
node dist/bridge/sync/main.js <dir> --once          # push everything once and exit
node dist/bridge/sync/main.js <dir> --pull          # pull: Studio → disk, then poll every 2 s
node dist/bridge/sync/main.js <dir> --pull --once   # pull once (bootstrap a project directory from a place)
node dist/bridge/sync/main.js <dir> --no-hotpatch   # push without touching a running playtest
node dist/bridge/sync/main.js <dir> --port 47801    # bridge port (default STUDIO_LIVE_PORT or 47800)
```

`studio-live sync <dir> [--pull] [--once] [--no-hotpatch] [--port N]` is the same command (`bridge/src/cli.ts` dispatches `sync` to `runSync` in `bridge/src/commands.ts`, which drives `startSync`). During development: `npx tsx bridge/src/sync/main.ts <dir> …`.

Programmatic use:

```ts
import { startSync } from './bridge/src/sync/index.js';
const handle = await startSync({ dir: 'C:/proj/src', port: 47800, pull: false, once: false, hotpatch: true, log: (line) => console.error(line) });
handle.stats(); // { pushed, pulled, errors, lastEvent }
await handle.stop();
```

`startSync` resolves after the first full pass (initial push or initial pull). With `once` that is the whole job; otherwise the watcher (push) or the poller (pull) keeps running until `stop()`. Log lines go to the `log` callback (default: stderr with a `[sync]` prefix — stdout is never used, so the sync can live inside the bridge process one day without corrupting the MCP transport).

A bridge must be running (`studio-live serve` or the MCP server started by Claude Code) and Studio must be connected to it; while either is missing the sync waits and retries (see Robustness).

## Layout (Rojo-compatible subset)

```
<dir>/
  ServerScriptService/
    Main.server.luau            → Script          ServerScriptService.Main
    Game/
      init.server.luau          → Script          ServerScriptService.Game       (the directory IS the script)
      Combat.luau               → ModuleScript    ServerScriptService.Game.Combat (child of the Game script)
  ReplicatedStorage/
    Shared/                     → Folder          ReplicatedStorage.Shared        (or an existing instance of that name)
      Types.luau                → ModuleScript    ReplicatedStorage.Shared.Types
  StarterPlayer/
    StarterPlayerScripts/       → the existing StarterPlayerScripts instance
      Input.client.luau         → LocalScript     StarterPlayer.StarterPlayerScripts.Input
  Workspace/
    Door/                       → existing Model "Door", or a new Folder
      DoorScript.server.luau    → Script          Workspace.Door.DoorScript
```

Rules:

- `<Name>.server.luau` → `Script`, `<Name>.client.luau` → `LocalScript`, `<Name>.luau` → `ModuleScript`. The rest of the file name is the instance name verbatim (`Foo.bar.luau` is a ModuleScript named `Foo.bar`).
- A directory containing `init.server.luau` / `init.client.luau` / `init.luau` **is** that script; its other files become the script's children (Rojo's init convention). When more than one init file exists, `init.server.luau` wins over `init.client.luau` over `init.luau` and the losers are reported. A flat `Game.server.luau` next to a `Game/` directory with an init file is ambiguous: the directory wins, the flat file is reported and skipped.
- Every other directory maps to an instance of the same name: an existing one is reused whatever its class (`StarterPlayerScripts`, a `Model` in `Workspace`, …); a missing one is created as a `Folder`.
- Top-level directories must be services (`Workspace`, `ServerScriptService`, `ServerStorage`, `ReplicatedStorage`, `ReplicatedFirst`, `StarterPlayer`, `StarterGui`, `StarterPack`, `Lighting`, `SoundService`, `TextChatService`, …): the program resolves them with `game:GetService(name)` and reports a directory that is not a service. `StarterPlayer/StarterPlayerScripts` and `StarterPlayer/StarterCharacterScripts` are nested directories, as in Rojo. A file directly in `<dir>` or an init file directly in a service directory is reported and skipped (a service cannot be a script).
- Ignored: every non-`.luau` file, every directory or file whose name starts with `.` (`.git`, `.vscode`, the sync's own `.studio-live-sync.json`). `.lua` files are ignored too — rename them.
- Sources are read as UTF-8; a UTF-8 BOM is stripped (the Luau parser rejects it). Line endings are normalised to LF on both sides.

## Push (default)

1. Initial scan: every `.luau` file is mapped and shipped. The pass is **one `run` tool call per batch** in the edit DataModel with `undo_label: "sync: N file(s)"` — one undo step in Studio per batch. The program (`bridge/src/sync/luau.ts` → `PUSH_PROGRAM`, data in `ARGS.items`) creates missing parents (`Folder`s, or the script class for init directories), creates missing scripts with the right class (`S.script.create`), writes sources through `S.script.set` (`ScriptEditorService:UpdateSourceAsync`, so an open editor tab follows), skips scripts whose source is already identical, and replaces a script whose class changed on disk (children are re-parented to the new instance). Each item's outcome is reported back (`created | updated | unchanged | replaced | skipped` plus a reason for skips).
2. Then `fs.watch` (recursive) with a **200 ms debounce**. Every burst triggers a stat-based rescan: only files whose content hash changed (or that are new) are pushed, so editor save dances (write temp + rename) and touches without changes cost nothing. A batch is capped at **400 KB** of program text plus sources; bigger batches are split into several `run`s (a single file larger than the cap still travels alone).
3. **Deletions are not propagated.** Deleting a file prints `WARN deleted on disk: … deletions are not propagated to Studio (deleteOrphans is not implemented)`; remove the instance in Studio yourself. `opts.deleteOrphans` is reserved for a future version and does nothing today.
4. **Hot-patch.** After a batch that changed something, if `observe status` reports `playtest.running` and `hotpatch` is not `false`, every changed `Script` / `ModuleScript` under `ServerScriptService`, `ServerStorage`, `ReplicatedStorage` or `Workspace` is also sent as `playtest {action: "hotpatch", dm: "server", path, source, restart: true}` — the live play-server gets the new source in the same frame budget as the agent's own hotpatches (~60 ms), a `Script` is restarted (`Disabled` toggle), a `ModuleScript` only gets its source (the require cache is unaffected; the log repeats the hub's note). A script that does not exist in the play server (created after the playtest started) fails its hotpatch with a warning. `LocalScript`s and anything under `StarterPlayer`, `StarterGui`, `StarterPack`, `ReplicatedFirst` are **not** hot-applied: existing clients already copied their Starter* content and cannot be reached; the log says so and the change takes effect on the next playtest. `--no-hotpatch` disables the whole step.

Edit-DataModel writes are serialised by the hub's FIFO write queue: a batch that arrives while the agent's own `run` is in flight waits its turn (a `queued behind N` progress note after 250 ms; `busy` only once 500 requests are waiting, which the sync retries with back-off). While a playtest runs the ChangeHistory recording is unavailable (`undo: unavailable`), the push still happens.

## Pull (`--pull`)

1. A checksum listing (`LIST_PROGRAM`, `dry_run: true`, `response_format: "detailed"`) walks every service except the Studio-internal ones and returns `{n: [name chain], c: class, h: "<bytes>-<hash>"}` per script, paged with `ARGS.offset` / `ARGS.limit` (≤ 200 per call). The hash is a byte-wise `(h * 31 + byte) mod 2^32` over the LF-normalised source, computed identically in Luau and in `state.ts`, so nothing is fetched unless it differs.
2. Scripts whose hash differs from the sync record (or that are missing on disk) are fetched with `FETCH_PROGRAM`: sources come back as UTF-8-safe slices of ≤ 4 KB (the §7 serializer truncates strings at 8 KB) inside pages of ≤ 24 KB of raw source, and a source longer than a page continues in the next call from `next`. If the bridge still truncates a page (`…[+N chars]` markers), the page size is halved and the call repeated. Sources are **never truncated** on disk; a checksum mismatch between what Studio computed and what was written is reported (it would mean a hash parity bug — please report it).
3. Files are written with LF line endings into the layout above (`Main.server.luau`, or `Main/init.server.luau` when the script has script descendants), directories created as needed, atomically (temp file + rename). A script that switches between flat and directory form leaves the old file behind: the log names the stale file; delete it by hand. Scripts removed in Studio are also left on disk (deletions are not propagated in either direction) with one warning per file.
4. Unless `--once`, the listing runs again **every 2 s**. Each poll costs one short edit-DataModel `run` per 200 scripts (the sources are hashed in Studio, nothing leaves it unless changed). When a listing takes more than 50 ms in Studio (thousands of scripts, megabytes of source) the interval stretches to 20× that time (≤ 30 s) and the log says so. `observe diff` is not used: it sees instance additions/removals but not `Source` edits, which is exactly what a pull needs to notice.

The read-only programs run as `dry_run: true` so that polling every 2 s leaves no waypoint in Edit → Undo; while a playtest runs no recording can be opened (`busy … dry_run needs a ChangeHistory recording`) and they run without one, which changes nothing either.

Names that cannot be files (`/ \ : * ? " < > |`, control characters, trailing dot/space, Windows device names, names starting with `.`, an instance literally named `init` or ending in `.server` / `.client` without children) are reported once and skipped. Two instances that would map to the same file (case differences on Windows are *not* detected) keep the first one.

## Conflicts

`<dir>/.studio-live-sync.json` records `{ files: { "<rel>": { hash, mtime } } }` — the content hash of every file as it was last synced (either direction). It is the only state; delete it to start over.

- **Push mode: the disk wins.** For every pushed file the program compares Studio's current source with the recorded hash (`ARGS.items[i].prev`). If Studio's copy changed since the last sync *and* differs from what is being pushed, the file is still overwritten and the log carries `WARN conflict: <rel> — Studio's copy changed since the last sync; the disk version was pushed (push mode: disk wins)`. A file with no record whose Studio copy is non-empty and different is overwritten too, reported as a single `note:` line (first push of a directory into a place that already has those scripts).
- **Pull mode: Studio wins.** Before writing, the local file is hashed: if it changed since the last sync *and* Studio's copy changed too, the file is overwritten with `WARN conflict: <rel> — both the file and Studio's copy changed since the last sync; Studio's version wins (pull mode)`. A local edit with no change in Studio is left alone (nothing to pull). A file with no record that differs from Studio is overwritten with a warning.
- Comparisons ignore CRLF/LF differences and a leading BOM.

Push and pull are two directions of one tool, not two daemons: run push while you edit on disk, pull (once) to bring a place into a directory. Running both against the same directory at the same time makes them fight over the state file and is not supported.

## Robustness

- `/rpc` failures that mean "not right now" — connection refused (bridge restarting), `no_session` (Studio not connected), `busy`, `timeout`, `disconnected`, `proxy_unreachable` — are retried with exponential back-off (250 ms → 5 s, `busy` at a quarter of that) for 30 s per call. In push mode a batch that is still failing after that stays queued and is retried on its own back-off for as long as the sync runs; the log shows `bridge not ready (…); retrying` once and then every fifth attempt. With `--once` the first pass fails after the 30 s budget and the process exits non-zero.
- Program errors (`luau_error`, `syntax_error`, `bad_request`) are logged with the message and counted in `stats().errors`; the batch is dropped (the files are pushed again when they change). A `run` that outlives the tool's 50 s wait is treated as a failure, never waited on.
- A file that cannot be read (locked, deleted between scan and read) is skipped with a warning; nothing crashes the watcher. When recursive `fs.watch` is unavailable the sync polls the directory once a second instead.
- Every log line is also the `lastEvent` in `stats()`; `WARN …` lines name the file; `ERROR …` lines are counted.

## Limits

- Scripts and Folders only. No properties (`Disabled`, `RunContext`, attributes), no `.meta.json`, no models, no `LinkedSource`. Package scripts and anything under `CoreGui` / `CorePackages` / `StudioService` / `PluginGuiService` / `Stats` are never listed.
- No deletions in either direction (see above). No renames: a renamed file is a new instance plus an orphan.
- The edit-DataModel write queue is shared with the agent: each push is one short `run` (≈ 1 ms + `UpdateSourceAsync` per script); each pull poll is one `run` per 200 scripts. A very large place makes polling visible to the agent as queue wait (tens of milliseconds every interval, reported as `queued behind N` once it exceeds 250 ms), never as `busy`.
- Multiple Studios connected to one bridge: the sync uses the bridge's *active* session and does not pass `session`; writes are refused with `bad_request` while two hubs are connected (the bridge's rule) and the log shows it.
- Hash collisions (32-bit polynomial plus length) would hide an edit of exactly matching length and hash; astronomically unlikely for real edits, but this is not a cryptographic hash.

## When to use real Rojo instead

Use [Rojo](https://rojo.space) when you need any of: models and properties (`.model.json`, `.meta.json`, `.rbxm`), `project.json` trees with several places, deletions and renames tracked as such, `.lua` files, Wally packages, or a CI build (`rojo build`). Rojo owns its own plugin and port and coexists with Studio Live.

Use this sync when the agent and a human edit the same scripts and you want: one undo step per batch, hot-patching into the playtest the agent keeps alive, no extra plugin, and a directory the agent can `grep`/edit with ordinary tools while `observe`/`run` keep working through the same bridge.
