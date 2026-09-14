# Studio Live — agent guide

You are talking to a live Roblox Studio through nine tools. This guide is the working style plus concrete examples for the acceptance tasks in [architecture.md](architecture.md). The wire contract is [protocol.md](protocol.md); the resident Luau API `S` is its §6, event types §2.5, value serialization §7. Tool argument names follow the protocol op bodies (§4); the tool schema is authoritative when it differs. Items marked **(v1.1)** were specified from the live findings and the [multi-agent build report](multi-agent-build-report.md) of 2026-09-11; their contract is fixed, their live check is the next step.

## Working style

1. **Ship programs, not micro-calls.** A `run` executes a whole Luau chunk with `S`, `ARGS`, `print`, `warn` and the normal Roblox globals, and returns its `return` value serialized. One turn should build, inspect, or verify a whole thing. Ten one-liners cost ten LLM turns; one program costs one.
2. **Read the DataModel; look at pixels only for visual questions.** `observe tree/find/props/diff/player/logs/stats/script` are exact and cost milliseconds — use them for anything that *is* state (positions, properties, script text, log lines, health, whether an instance exists). For a question only pixels can answer — rendering and lighting, UI layout as the player sees it, which Studio dialog is open, "is the character stuck in the wall?" — use `look { question }`: the bridge screenshots Studio and a vision model answers in **text**, so no image enters your context; `look { watch: { question, interval_s, stop_when } }` keeps watching and streams `vision` events (unchanged frames cost nothing). `observe screenshot` returns the image itself (~1 100 tokens at 1024 px, re-sent every turn it stays in context); take one only when you must see the pixels yourself. Vision answers are approximate — verify anything actionable with a structured read. See "look vs observe" below.
3. **Keep the playtest alive.** `playtest start` costs ~2 s of engine time (24 s for a multiplayer test); a restart is never the inner loop. Change behaviour with `playtest hotpatch`, `run` in the play DataModel, `playtest push`, or by (re)installing a controller. State written in play DataModels is `ephemeral`: discarded at stop, not undoable.
4. **Push the fast loop into Studio.** Anything that must react within frames — walking, pressing, waiting for a door — is a *controller* or a `run_until` predicate that runs at Heartbeat in-engine and reports `assert`/`milestone`/`custom` events. You act on the events, not on frames.
5. **Arm push once, then trust it.** `Monitor({ ws: { url: 'ws://127.0.0.1:47800/events' }, persistent: true })`. Frames arrive as `{"batch":[…events…],"seq":N,"dropped":0}`; a heartbeat every 30 s carries `alive` DataModels. If a frame shows `dropped > 0` or `seq` skipped, call `events { since: <last seq you saw> }` to backfill. If Monitor is unavailable, `events` with `timeout_ms: 25000` is the same journal as a long poll.
6. **Edit-DataModel writes are one undo step.** Every edit `run` is wrapped in a `ChangeHistoryService` recording labelled `undo_label`; an error rolls the whole program back — *for everything except instances you `:Destroy()` yourself* (see "Deleting things"). Give labels the human will recognise in Edit → Undo (`agent: build arena`). `dry_run: true` runs and always rolls back.
7. **Never put Luau through a shell.** Heredocs and quoting turn `\n` inside a Luau string into a real newline and the program fails with `Malformed string`. Pass code from a file: `code_file` / `source_file` / `predicate_file` on the tools, `--code-file` on `studio-live call` **(v1.1)**. See "Passing Luau safely".
8. **Stay small.** Results are capped (`concise` ≈ 20 KB). Ask `observe` for `fields` you need, `max` you can read, `depth` you will use. Return summaries from programs, not whole tables. Long work returns a job handle — `job wait` it rather than polling.
9. **Save what works.** `skills save` stores a program on disk; `skills run` executes it with new `ARGS` in a later session. Eight builtin skills ship with the bridge (`skills list` marks them `builtin: true`) — check them before writing a physics settle, profiler capture or attribute sweep yourself.
10. **Open Cloud needs no ids from you.** `cloud` reaches data stores, ordered and memory stores, MessagingService, place publishing, the asset lifecycle, server-side Luau, the Instance API, bans and notifications for the open place; `universe_id`, `place_id` and the creator default from the connected Studio session, so pass them only to address another experience. Start cloud work with `cloud { action: "info", what: "key" }` — it reads what the key may do, writes included, before you plan around it. See "Open Cloud for the open place".
11. **Sharing a Studio with other agents?** Read "Multi-agent contract" first: shared roots via `S.ensure`, never destroy what you did not create, one owner for Workspace-level cleanup.
12. **No parts in parts.** Every edit-DM `run` checks the parts it added for intersections with other parts and for `Part`s parented under `Part`s, and reports them in `geometry` + `warnings`; a non-empty `geometry` is a failed step — fix it before building on top (`S.placeOn`, `S.fits`). `geometry_policy: "reject"` makes such a run roll back. See "Geometry rules (enforced)".

Coordinate systems, once: `AbsolutePosition` on GUI objects is *GUI space*; a screenshot shows *viewport space*, which is GUI space shifted down by `GuiService:GetGuiInset()` (58 px on this build). The `input` tool's `gui` flag (default `true`) says which one you are passing — see the input example.

## Passing Luau safely: code from files (v1.1)

Three agents in the multi-agent test lost turns to the same non-bug: a pattern like `"[^\n]+"` or a string with `\n` in it arrived in Studio with a **real newline** inside the quotes, because the shell heredoc (or the JSON quoting layered on it) collapsed `\\n` before the bridge ever saw the request. The bridge itself is escape-clean — `return #"a\nb"` is `3` through `POST /rpc` — so the fix is to keep Luau out of the shell entirely:

| Tool | Text argument | File alternative (absolute path, UTF-8, BOM stripped; mutually exclusive with the text form) |
|---|---|---|
| `run` | `code` | `code_file` |
| `playtest install` | `code` | `code_file` |
| `playtest hotpatch` | `source` | `source_file` |
| `playtest run_until` | `predicate` | `predicate_file` |
| `skills save` | `source` | `source_file` |

```json
run { "dm": "edit", "undo_label": "agent: build map", "code_file": "C:\\work\\map.luau", "args": { "cols": 20 } }
```

From a shell or a subagent, `studio-live call` takes the same files as flags and merges them into the arguments; it exits 1 when the result `isError`:

```powershell
studio-live call run --code-file C:\work\map.luau --args-file C:\work\map.args.json
studio-live call playtest '{"action":"hotpatch","dm":"server","path":"ServerScriptService.Door"}' --source-file .\Door.server.luau
studio-live call playtest '{"action":"run_until","dm":"server","timeout_ms":20000}' --predicate-file .\door_open.luau
```

`--args-file <json>` is the whole argument object (other flags and the positional JSON merge into it). Write the file with your file tool, not with `echo`.

If you still see `syntax_error … Malformed string`, the message now ends with the hint *"your transport turned \n into a newline — pass code from a file (code_file)"* whenever the received code has a raw newline inside a quoted literal. The bridge's selftest compiles a program containing `"\n"` and `"[^\n]+"` inside Luau strings, so a failure here is never the bridge. Do **not** work around it with `string.char(10)`; fix the transport.

## T4 — build a 2000-part arena as one undo step

One `run` in the edit DataModel. `S.yield()` inside the loop keeps Studio at 60 Hz (it yields a Heartbeat only when the current slice has exceeded 8 ms) and is the cancellation point.

```json
run {
  "dm": "edit",
  "undo_label": "agent: build arena 50x40",
  "args": { "cols": 50, "rows": 40, "step": 4 },
  "code_file": "C:\\work\\arena.luau"
}
```

```lua
local cols, rows, step = ARGS.cols, ARGS.rows, ARGS.step
local origin = Vector3.new(0, 0.5, 0)
local arena = S.ensure("Workspace.Arena", "Model")        -- create-if-missing: safe to re-run, safe next to other agents
local n = 0
for i = 0, cols - 1 do
  for j = 0, rows - 1 do
    local rim = i == 0 or j == 0 or i == cols - 1 or j == rows - 1
    local x = (i - cols / 2 + 0.5) * step
    local z = (j - rows / 2 + 0.5) * step
    S.part({
      Name = rim and "Wall" or "Tile",
      Size = rim and Vector3.new(step, 12, step) or Vector3.new(step - 0.5, 1, step - 0.5),
      CFrame = CFrame.new(origin + Vector3.new(x, rim and 6.5 or 1, z)),
      Material = rim and Enum.Material.Slate or Enum.Material.SmoothPlastic,
      Color = rim and Color3.fromRGB(70, 70, 80) or Color3.fromRGB(120 + (i + j) % 2 * 60, 140, 150),
      Parent = arena,
    })
    n += 1
    S.yield()
  end
end
-- a door in the south wall, with the state the walker will test
local door = S.part({
  Name = "Door", Size = Vector3.new(step, 10, 1), Anchored = true,
  CFrame = CFrame.new(origin + Vector3.new(0, 5.5, (rows / 2) * step - 0.5)),
  Color = Color3.fromRGB(200, 120, 40), Attributes = { Open = false }, Tags = { "Door" }, Parent = arena,
})
return { parts = n + 1, arena = S.path(arena), door = S.path(door) }
```

Response: `{ value: { parts: 2001, arena: "Workspace.Arena", door: "Workspace.Arena.Door" }, changes: { added: 2002, removed: 0, paths: ["Workspace.Arena"] }, undo: "committed", duration_ms: … }`. Measured live: 70 ms. One Ctrl+Z in Studio removes all of it. If the response says `undo: "unavailable"`, a playtest was running or another recording was open; the build still happened.

Save it for next time: `skills { action: "save", name: "arena", source_file: "C:\\work\\arena.luau" }`, later `skills { action: "run", name: "arena", args: { cols: 30, rows: 30, step: 6 } }`.

## Deleting things: `S.destroy` vs `:Destroy()` (v1.1)

`Instance:Destroy()` locks `Parent`. `ChangeHistoryService` can then neither roll the instance back on an error/`dry_run` (`Cancel`) nor bring it back on Ctrl+Z — in the multi-agent test a `dry_run` of a "destroy old, rebuild" program removed the rebuilt copies and did **not** restore the originals. Rules:

- In the edit DM, **`S.destroy(inst | path | {…})` sets `Parent = nil`** and keeps the reference until the recording is finished, so `Cancel` and Undo restore it. Use it for every delete in an edit-DM program.
- A raw `:Destroy()` inside an edit-DM `run` is **not undoable and not rolled back by `dry_run`**. The run response carries `warnings: ["program calls :Destroy( …"]` when the program text contains `:Destroy(`; treat the warning as a bug in your program unless the instance was created in the same program and never parented.
- Idempotent builders should not delete-and-rebuild at all: `S.ensure` the root, then reconcile children (rename, re-set props, `S.destroy` only what is truly stale).
- Play-DM programs may `:Destroy()` freely — nothing there is undoable anyway.

## Geometry rules (enforced)

"Parts in parts" is the mistake every agent-built scene shows: a deck clipping through a wall, a ramp buried in the platform it should meet, pillars sunk into tiles — and `Part`s parented under `Part`s in the Explorer. Telling an agent about it once per session does not work, so the tool checks after every edit-DM `run` and reports (or rejects). You do not have to remember; you have to read the result.

**What counts.**

- **Overlap:** two BaseParts whose volumes intersect by more than `tolerance` (0.05 studs). Faces that merely touch are fine — a tile resting on a floor, wall segments end to end, a roof sitting on its walls are *not* overlaps. Block `Part`s are tested exactly (oriented boxes; `depth` is the penetration in studs). Wedges, spheres, cylinders, meshes and unions are tested on their bounding boxes and flagged `approximate: true` — a wedge ramp whose box clips the platform it visually meets deserves a look, not an automatic fix. Pairs where one part has `CanCollide = false` are flagged `decor: true` (a glow part inside a lamp is intended; a decor part inside a wall usually is not). Terrain is never a candidate.
- **Nested:** a BasePart whose `Parent` is a BasePart. Attachments, decals, textures, lights, constraints, sounds and scripts under a part are fine; parts belong in a `Model` or a `Folder`.

**How you see it.** Every edit-DM `run` (and `skills run`) checks the parts *that program added or moved through `S`* (`S.set`, `S.placeOn`, `S.snapToGrid`, `S.grid`, the `PlaceOn` prop — a pre-existing deck you push into a wall counts; a raw `part.CFrame = …` write is not seen until `observe geometry`) — up to 5000; beyond that it samples and says `sampled: true` — against everything in Workspace, right after the program returned, inside the same undo step:

```json
{ "value": { "parts": 212 }, "undo": "committed", "changes": { "added": 212, "removed": 0, "paths": ["Workspace.Map"] },
  "geometry": {
    "overlaps": [ { "a": "Workspace.Map.Deck", "b": "Workspace.Map.WallEast", "depth": 1.5, "aClass": "Part", "bClass": "Part" } ],
    "nested":   [ { "path": "Workspace.Map.Pillar.Cap", "parent": "Workspace.Map.Pillar", "class": "Part" } ],
    "checked": 212, "ms": 4.1, "totals": { "overlaps": 1, "nested": 1 } },
  "warnings": [
    "1 overlapping part pair (e.g. Workspace.Map.Deck ⟂ Workspace.Map.WallEast, 1.5 studs) — fix before continuing (move, resize or S.placeOn them); see geometry",
    "1 part parented under another part (e.g. Workspace.Map.Pillar.Cap under Workspace.Map.Pillar) — parts belong in a Model or Folder, never under a BasePart; see geometry" ] }
```

`geometry` and `warnings` are absent when the build is clean. The lists hold at most 50 entries each; `totals` counts everything. **Treat a non-empty `geometry` as a failed step:** fix it in your next `run` (move or resize the offenders, re-parent nested parts into a Model), then confirm with `observe { what: "geometry", root: "Workspace.Map" }` before you build on top of it. Do not "fix" an overlap by shrinking the tolerance.

`geometry_policy` on `run` / `skills run`:

| Policy | What happens | When |
|---|---|---|
| `warn` (default; `STUDIO_LIVE_GEOMETRY_POLICY` sets the bridge-wide default) | the run commits; `geometry` + `warnings` are in the result | normal building: you fix and continue |
| `reject` | the run is rolled back (`FinishRecording(Cancel)`, nothing of it lands) and fails with `error.code: "geometry_violation"` carrying the same `geometry` report, `warnings`, `undo: "cancelled"` and the program's `output` | a violation must never reach the place: final assembly passes, subtrees other agents build on, work the human will save without reviewing — and as the operator's default when an agent keeps building on top of warnings |
| `off` | no check | bulk imports you will audit with `observe geometry` afterwards; intentional intersections (CSG negatives, rock piles hugging terrain, a seam-hiding sink of more than 0.05 studs) |

Play-DM runs (`dm: "server" | "client:N"`) are checked only when you pass `geometry_policy` — their parts are ephemeral. A `dry_run` is checked like any other run (the report tells you what *would* have landed).

**Audit a subtree** — things you did not build, an `off` run, or the whole map before handing over:

```json
observe { "what": "geometry", "root": "Workspace.Map", "max": 5000, "tolerance": 0.05, "include_nested": true }
```
→ `{ overlaps: [...], nested: [...], checked, sampled, ms, totals }` with the same entries, up to 200 per list. `dm` audits the copy in a play DM.

**Placing things without overlaps** — the `S` helpers exist so the fix is one line, not arithmetic:

```lua
local map = S.ensure("Workspace.Map", "Model")
local floor = S.get("Workspace.Map.Floor")
local crate = S.part({ Name = "Crate", Size = Vector3.new(4, 4, 4), CFrame = CFrame.new(12, 0, -3), Parent = map })
S.placeOn(crate, floor)                                     -- bottom of the crate on the floor's top face; X/Z kept
S.placeOn(crate, floor, { align = "center", gap = 0.1 })    -- centred on the floor, 0.1 studs above it
local lamp = S.part({ Name = "Lamp", Size = Vector3.new(1, 6, 1), PlaceOn = crate, Parent = map })   -- props.PlaceOn = sugar

-- Ask before you place: does a 6×8×1 door frame fit at this pose?
local ok, blockers = S.fits(CFrame.new(0, 4, 20), Vector3.new(6, 8, 1), { ignore = { floor } })
if not ok then return { blocked_by = blockers } end        -- paths of the parts it would penetrate

-- Check what you built, inside the program (same rules and entries as the run report):
local bad = S.overlaps(map)                                 -- { {a, b, depth, aClass, bClass, approximate?, decor?}, … }
S.snapToGrid(crate, 0.5)                                    -- pivot rounded to 0.5 studs (a number or a Vector3)
return { overlaps = #bad }
```

`S.placeOn(part, target, { align = "keep" | "center", gap = 0 })` accepts a `Model` on either side (its bounding box), keeps rotation and returns the part. `S.fits(cframe, size, { ignore = {…}, tolerance })` returns `ok, blockers` (block parts exact, other shapes by bounds; `ignore` excludes instances and their descendants — pass the part you are about to move). `S.overlaps(instOrList, { tolerance, max, against = "all" | "self" })` takes parts, containers or paths; `against = "self"` checks only the given parts against each other.

**Habits that keep the report empty:** compute Y from the thing below (`S.placeOn`) instead of guessing heights; size gaps from the neighbours' real `Size`, not constants; build rows with `S.grid` and a `step` at least the part size; parent every part to a `Model` or `Folder` (`Parent = model`, never `Parent = otherPart`); move existing parts with `S.set` / `S.placeOn` rather than raw property writes so the check sees them; and read `geometry` after every build turn. Sinking a wall 0.05 studs into the floor to hide a seam is within the tolerance; anything deeper is reported.

## T1 — install a `walker` controller with assertions

Start the playtest (once), then ship a controller. The controller runs at Heartbeat in the client's plugin VM; assertions and milestones reach you as pushed events while the human keeps editing.

```json
playtest { "action": "start", "mode": "play" }
```
→ `{ running: true, mode: "play", peers: [{ dm: "server", connected: true }, { dm: "client:1", connected: true, userId: …, playerName: … }], started_ms: ~2000 }`. `no_peer` here means Studio's *Load User Plugins In Run Modes* is off or the plugin is not installed.

```json
playtest { "action": "install", "dm": "client:1", "name": "walker", "persist": true, "code_file": "C:\\work\\walker.luau" }
```

```lua
return {
  load = function(ctx)
    local S = ctx.S
    local door = S.get("Workspace.Arena.Door")
    if not ctx.assert("door_exists", door ~= nil, "Workspace.Arena.Door missing") then return end
    ctx.storage.runs = (ctx.storage.runs or 0) + 1
    ctx.milestone("walker_started", { run = ctx.storage.runs })

    local char = ctx.character()            -- the Character model, once it has a HumanoidRootPart
    local hrp = char.HumanoidRootPart
    local humanoid = char:FindFirstChildOfClass("Humanoid")
    ctx.onEvent(humanoid.Died, function()
      ctx.assert("alive", false, "character died at " .. tostring(hrp.Position))
    end)

    -- Fast loop, no model in it: walk to the door, use it, judge the result.
    task.spawn(function()
      local goal = door.Position + Vector3.new(0, 0, 8)
      local reached, reason = ctx.pathTo(goal, 15)   -- PathfindingService; ctx.moveTo is the straight-line version
      if not ctx.assert("reached_door", reached, "pathTo failed: " .. tostring(reason) .. ", at " .. tostring(hrp.Position)) then return end
      ctx.milestone("at_door", { dist = S.distance(hrp, door) })
      ctx.input.press("E")
      ctx.after(1.5, function()
        ctx.assert("door_opens", door:GetAttribute("Open") == true,
          "expected Open=true 1.5 s after pressing E, got " .. tostring(door:GetAttribute("Open")))
      end)
    end)

    -- Telemetry every 5 s for 60 s; you will see these as `custom` events only if you subscribed to them.
    local elapsed = 0
    ctx.every(5, function()
      elapsed += 5
      local st = ctx.state()
      ctx.emit("walker_state", { t = elapsed, p = st.position, hp = st.health, floor = st.floorMaterial })
      if elapsed >= 60 then ctx.milestone("walker_done", { assertions = "see journal" }) end
    end)
  end,
  unload = function() end,
}
```

Response `{ installed: "walker", replaced: false, persist: true, persist_source: "bridge", persist_file: "<home>/persist/<placeId>.json" }` (`persist_file` is absent for an unsaved place — memory only, lost on a bridge restart; `persist_note` instead of `persist_file` means the bridge could not write its home directory; a same-name install *without* `persist` answers `persist: false, persist_removed: true`). An install that outlives `wait_ms` (a slow client Studio) comes back as `{ job_id, status: "running", persist_pending: true }` and is stored the moment the hub acknowledges it — `playtest list` shows it, you need not wait. Reinstalling with the same name unloads the previous instance first (all `ctx.onEvent`/`ctx.every`/`ctx.onHeartbeat` hooks are disconnected for you); `ctx.storage` survives the reinstall.

**What `persist: true` means (v1.1).** Studio 0.738's `plugin:GetSetting` returns `nil` for every key, so nothing durable can live in plugin settings. The **bridge** keeps the controller instead: `{placeId, dm, name, code}` in memory for the session and in `<STUDIO_LIVE_HOME>/persist/<placeId>.json`. Every time a hub connects (first connect, socket refresh, a bundle push that restarts the runtime) the bridge sends it the whole list (`persist_sync`), and the hub installs the entries for a DM whenever that DM's runtime says hello — a `playtest start` of any mode, a test started from Studio's own Play button, a client joining a multiplayer test late. It therefore survives hub runtime restarts, bridge restarts and reopening the place. `uninstall` removes the entry for good (also when no playtest is running — the answer is then `{ uninstalled: false, persisted_removed: true }`), and so does a later install of the same name without `persist`. `playtest { action: "list" }` shows every controller with its `persist` flag and lists the persisted entries with `source: "bridge"`; `playtest status → persisted[].error` names a persisted controller whose re-install failed on a peer (it is retried on that peer's next hello, not on every sync). Two Studios on the same `placeId` (a `twin`) share the place file: it holds the union of both sessions' lists, so one session's `uninstall` never removes the other's entry.

**Walking (v1.1).** `ctx.moveTo(pos, timeout?)` is straight-line: `Humanoid:MoveTo` re-issued each Heartbeat, judged by horizontal distance — fine on a flat arena, wrong for a coin on a deck above the bot (the Coin Rush tester saw `reached=false … dist 16.7` for exactly that). `ctx.pathTo(pos, timeout?, agentParams?)` (also `S.pathTo` in play DMs; `timeout` defaults to 20 s, `agentParams` overrides `{ AgentCanJump = true, AgentRadius = 2, AgentHeight = 5 }`) computes a path with `PathfindingService:ComputeAsync`, walks the waypoints with `MoveTo` re-issued every Heartbeat, jumps on `Jump` waypoints, jumps once more when a waypoint makes no progress for 1.5 s and then recomputes the path (up to three computes), and returns `reached: boolean, reason?` — `"wrong_dm"`, `"no_character"` (none at start, or the character died / despawned mid-walk), `"no_path:<PathStatus>"` (e.g. `no_path:NoPath`), `"compute_error: …"`, `"unreachable:<studs>"` (every waypoint reached but the goal is off the navmesh — a coin floating 4 studs past a ledge; the number is the remaining horizontal distance; also answered as soon as a recompute ends no closer than the last one), `"stuck"` (three computes without arriving) or `"timeout"`. The walk is cancelled on every return, so the character does not keep going. `ctx.moveTo` returns the same pair with `"no_character"` / `"timeout"`. Both **block the calling thread** until they return: call them from `ctx.after(0, …)` or a `task.spawn`ed loop, never inside `ctx.onHeartbeat`. Use `pathTo` whenever the target is not in plain sight; it is the one v1.1 helper that has not run live yet.

## T3 — a failing assertion reaches you without asking

With Monitor armed, when `door_opens` fails you receive a frame like:

```json
{"batch":[{"v":1,"kind":"ev","seq":10433,"t":1789.21,"wall":1789000123,"src":"client:1","type":"assert","name":"door_opens","ok":false,"detail":"expected Open=true 1.5 s after pressing E, got false","controller":"walker"}],"seq":10433,"dropped":0}
```

Act on it in the same turn: read the door script, fix it (T2), and let the walker retry with `playtest install` again. Do not poll `observe` in a loop waiting for it.

Recovering from a gap: if a frame carries `"dropped": 3` or the `seq` jumps from 10433 to 10440, fetch what you missed once:

```json
events { "since": 10433, "kinds": ["assert", "error", "milestone"], "timeout_ms": 1000 }
```
→ `{ cursor: 10440, events: [...], dropped: 0 }`. Continue from `cursor`. `events` is also the whole story when Monitor is gated off: call it with `timeout_ms: 25000` between actions and it returns as soon as something happens.

## T2 — change behaviour in the live playtest

**Wait for a condition in-engine** instead of polling from your side. The predicate runs in the target DataModel every Heartbeat (or every `interval_ms`) with the `run` environment:

```json
playtest {
  "action": "run_until", "dm": "server", "timeout_ms": 20000,
  "predicate": "local d = S.get('Workspace.Arena.Door'); return d and d:GetAttribute('Open') == true"
}
```
→ `{ result: true, value: true, elapsed_ms: 1340, checks: 81 }`, or `result: "timeout"`. An erroring predicate is retried up to 3× and then fails the call. Longer predicates: `predicate_file`.

**Read the script first — by line range when it is long (v1.1).** `S.script.get(path)` returns the whole source (script sources are exempt from the 8 KB string cap, up to the 60 K result budget); `S.script.get(path, { from = 120, to = 180 })` returns just those lines. Without a program:

```json
observe { "what": "script", "path": "ServerScriptService.DoorController", "from": 1, "to": 80 }
```
→ `{ path, class, lines: 80, total_lines: 273, text }`. Page with `from`/`to`; `dm` reads the copy in a play DM.

**Hot-patch the door script** without stopping anything. The source is replaced and the script restarted (`Disabled` toggled true→false), so the new code runs next frame:

```json
playtest { "action": "hotpatch", "dm": "server", "path": "ServerScriptService.DoorController", "restart": true, "source_file": "C:\\work\\DoorController.server.luau" }
```

For a surgical edit use the script helpers from a `run` on the same DataModel: `S.script.patch("ServerScriptService.DoorController", "MaxActivationDistance = 4", "MaxActivationDistance = 12")` then `S.script.restart(path)`. Remember `ModuleScript`s: writing their source does not affect already-`require`d copies — hotpatch returns `{ note: "require cache unaffected; re-require a clone" }`; restart the scripts that require it, or clone-and-require in your patch.

The same fix applied to the *saved* place is a separate, undoable step: `run { dm: "edit", undo_label: "agent: door prompt distance", code: "S.script.patch('ServerScriptService.DoorController', 'MaxActivationDistance = 4', 'MaxActivationDistance = 12')" }`. Play-DM writes vanish when the playtest stops; the edit DM is the one the human saves.

## Logs: startup output, and all DMs at once (v1.1)

Server scripts print their most useful line at start (`[CoinSpawner] 20 coins spawned`), before the play-DM runtime has said hello. Play-DM agents now seed their log journal from `LogService:GetLogHistory()` at start **with real seqs**, so those lines come back through the normal cursor paging — `observe { what: "logs", dm: "server", since: <seq at playtest start> }` includes them, and `events`/`observe logs` never need `since: 0` to see startup output. Those items carry `history: true` and their original `wall` stamp; a client's copy of a server print (a Play Solo test mirrors server output into the client's history) is dropped when the hub already holds the same *server* line within 2 s, so `dm: "all"` does not show it twice. Only client lines are checked and only against server lines: a server that prints `coin spawned` twenty times at start shows twenty lines, a client's own output is never dropped, and multiplayer test players (separate processes, nothing mirrored) are never deduped. If the client seeded before the server, `dm: "all"` shows the mirrored copy under both srcs — `dm: "server"` is always complete. (The hub's own seeded history — this Studio process's Output since launch — still carries `seq: 0` and is returned only for `since ≤ 0`.)

```json
observe { "what": "logs", "dm": "all", "since": 1172, "level": "warn" }     // every DM, merged; each line carries src
observe { "what": "logs", "dm": "server", "filter": "[CoinSpawner]" }
```

`dm: "all"` merges the hub's journal for edit, server and every client; lines carry `src` (`"edit"`, `"server"`, `"client:1"`). Output lines beginning with `[StudioLive]` are never turned into log events.

## Pressing a GUI button

**Exact path (preferred):** GUI objects tell you where they are. Read the button, click at its centre in GUI space, and let the runtime add the inset (`gui: true` is the default):

```json
run { "dm": "client:1", "code": "local b = S.get('Players.LocalPlayer.PlayerGui.Hud.Play'); return { pos = b.AbsolutePosition, size = b.AbsoluteSize, visible = b.Visible }" }
```
→ `{ pos: [860, 640], size: [200, 60], visible: true }`

```json
input { "dm": "client:1", "actions": [
  { "type": "click", "x": 960, "y": 670, "button": "left", "gui": true },
  { "type": "wait", "ms": 200 }
] }
```

**Visual path (when you only have pixels):** a screenshot is the whole Studio window scaled to `max_width`; the 3D viewport is the large area inside it. Convert screenshot pixels → window pixels → viewport pixels, and send them with `gui: false` (they already include the inset):

1. `observe { what: "screenshot", max_width: 1024 }` → `{ width: 1024, height: 826, source_width: 1734, source_height: 1399, scale: 1.693, … }`: `scale` is window pixels per screenshot pixel, reported for you.
2. Find the viewport's origin inside the window once per layout. Either eyeball where the 3D view starts below the ribbon, or make it unmistakable for one frame:
   `run { "dm": "client:1", "code": "local g = S.ui.screen('CalibrationOverlay', { IgnoreGuiInset = true, DisplayOrder = 1000 }); S.ui.frame(g, { Size = UDim2.fromScale(1,1), BackgroundColor3 = Color3.fromRGB(255,0,255), BackgroundTransparency = 0.5 }); task.delay(2, function() g:Destroy() end); return workspace.CurrentCamera.ViewportSize" }` → `[1400, 1100]`, then screenshot again: the magenta rectangle *is* the viewport; its top-left in the screenshot, say `(4, 60)`, times `scale` gives the viewport origin in window pixels, `(7, 101)`.
3. A button you see at screenshot `(400, 460)` is at window `(676, 777)` and viewport `(669, 676)`:
   `input { "dm": "client:1", "actions": [ { "type": "click", "x": 669, "y": 676, "button": "left", "gui": false } ] }`.
4. Verify by reading state, not by another screenshot: `observe { what: "props", paths: ["Players.LocalPlayer.PlayerGui.Hud"], props: ["Enabled"] }`.

Clicks that would land on CoreGui (top bar, chat, escape menu) throw in the engine; the step reports `ok: false` and the sequence continues unless `abort_on_error: true`. Mouse *movement* cannot be synthesised: `look` is best effort (the runtime locks the cursor, sends the delta and fails the step when the camera did not turn — the default camera script ignores virtual deltas), so turn the camera from a `run` instead: `workspace.CurrentCamera.CameraType = Enum.CameraType.Scriptable; workspace.CurrentCamera.CFrame = …`. Keys still held when a sequence is cancelled or aborts are released for you.

**No scrolling.** There is no `scroll` action: the engine's `SendPointerAction` accepts any dictionary and produces no MouseWheel events, so wheel input cannot be synthesised. Scroll a `ScrollingFrame` from a `run` on the client instead (`S.set("Players.LocalPlayer.PlayerGui.Shop.List", { CanvasPosition = Vector2.new(0, 400) })`).

## Multiplayer playtests

`mode: "multiplayer"` starts a server DataModel plus N separate client Studio processes; each connects to the hub and appears as `client:1..N` with `playerName` `Player1..N` and `userId` −1, −2, …:

```json
playtest { "action": "start", "mode": "multiplayer", "players": 2 }
```

Booting client Studios takes tens of seconds (measured live: 24 s for two clients, `add_players` 11 s for one more, `stop` 0.45 s), so the call usually comes back as `{ job_id, status: "running" }` — `job { action: "wait", job_id, wait_ms: 50000 }` until it reports `{ running: true, mode: "multiplayer", players: 2, peers: [server, client:1, client:2], started_ms }`. From then on every tool takes `dm: "client:2"` like any other client: `run`, `input`, `observe player`, `playtest install` (one controller per client; `persist: true` ones are installed in every client that appears, late joiners included). `playtest { action: "add_players", count: 1 }` adds a client to the running test; `stop` ends the whole test and closes every client window. Coordinate from the server: `run_until { dm: "server", predicate: "return #game.Players:GetPlayers() == 2" }` before starting the scenario.

Edit-DM writes stay serialized, but they queue: concurrent `run`s wait their turn in FIFO order (a `progress` note `queued behind N` after 250 ms; `busy` only once 500 are waiting, or for a `dry_run` that cannot open a recording). Measured live: 30 and 100 concurrent edit-DM `run`s, all `ok`, zero `busy`. Queued writes drain back-to-back within the 8 ms cooperative slice of a frame rather than one per frame **(v1.1)**, so a burst of small programs costs a few frames, not one frame each. Play-DM runs on different clients proceed concurrently.

## Pushing edit-DM instances into a live playtest

Build in the edit DataModel (undoable), then copy the result into the running test without a restart:

```json
playtest { "action": "push", "paths": ["Workspace.Arena"], "dm": "server" }
```

The hub serializes the instances (`SerializationService`; 200 parts ≈ 4 KB; measured live 72 ms serialize plus replication to the client), ships them to the play DM and deserializes them there → `{ dm: "server", paths: ["Workspace.Arena"], count: 1, bytes, replicated: true, replaced: 0 }`. Without `parent` every root lands at the path it has in the edit DM (`Workspace.Arena` → `Workspace.Arena`, `ReplicatedStorage.Config` → `ReplicatedStorage.Config`); `parent: "Workspace.Live"` puts them all under that instance instead, which must already exist in the target DM (`bad_request` otherwise, nothing left behind). Server-side pushes replicate to the clients like any server change; a push to `client:N` stays local to that client.

**`replace` (v1.1).** By default (`replace: true`) an existing sibling with the same name **and class** under the target parent is removed (`Parent = nil`) before the new root is parented, and the response reports `replaced: n` — pushing `Workspace.Arena` twice leaves one `Arena`, not two (the live probe without this left two `PushProbe` models). A same-named sibling of another class, `Terrain`, the current camera and player characters (a multiplayer client is literally `Workspace.Player1`) are never touched; they come back as `skipped: [{ path, reason }]` so you know a name clashed. `replace: false` keeps both. Like every play-DM write a push is ephemeral and not undoable. Large trees are fine (`timeout_ms` up to 120000, 4 MB of serialized data); ship what the test needs, not the whole place. `push` runs as a hub read, so it never waits behind queued edit-DM writes.

## Properties the plugin VM cannot touch (v1.1)

Programs run in Studio's plugin VM (`PluginSecurity`). Some properties are hidden from it entirely or need `RobloxScriptSecurity`; touching them fails with `… is not a valid member of …` (tagged `NotScriptable` in the API dump) or `lacking capability RobloxScript`. Measured on 0.738:

| Property | Read | Write | Error |
|---|---|---|---|
| `Lighting.Technology` | no | no | `lacking capability RobloxScript` |
| `Workspace.SignalBehavior` | no | no | `SignalBehavior is not a valid member of Workspace` |

Expect the same for any property whose API-dump security is `RobloxScriptSecurity` / `RobloxSecurity` or whose tags include `NotScriptable` (by tag, not individually measured: `Workspace.MeshPartHeadsAndAccessories`, `Workspace.RenderingCacheOptimizations`, `Workspace.PhysicsSteppingMethod`). Read-only properties (`DataModel.PlaceVersion`, `BasePart.AssemblyMass`, …) fail with "cannot be assigned to" — a different error that `S.set` still throws on. `PluginSecurity` properties (`Workspace.StreamingEnabled`, `Lighting.GlobalShadows`, `StarterPlayer.*`, script `Source`) work.

How the tools behave: `observe props` / `observe tree fields` / `S.props` silently omit a property they cannot read. `S.set(inst, props)`, `S.batchSet`, `S.new(class, props)` and `S.ensure(path, class, props)` no longer throw mid-program on such a property: the failures are collected and the run response carries `unwritable: [{ path: "Lighting", prop: "Technology", reason: "…lacking capability RobloxScript" }, …]` (at most 100; only for errors whose message contains `lacking capability` or `not a valid member`; a typo'd property name is *not* a valid member either and the plugin VM cannot tell the two apart, so read `unwritable` before assuming success — the run's `warnings` repeats it in one line, `"1 property could not be written and was skipped (engine-gated or misspelt; see unwritable): Part.Colour"`, and every other failure, a wrong value type for instance, still throws and rolls the program back). A direct `inst.Technology = …` in your own code still throws. Leave these to the human and the Properties panel — say so in your summary instead of retrying.

## Multi-agent contract (v1.1)

Several agents can drive one Studio at once — through MCP, `POST /rpc` or `studio-live call`. The edit-DM write queue serialises programs invisibly; what is *not* automatic is agreement about the tree. The contract that let five builders share one place in the Coin Rush test:

1. **Shared roots are named in advance and created with `S.ensure`.** `S.ensure(path, class, props?)` returns the existing instance at `path` or creates it (with `props`, inside the current recording); every agent calls it, whoever is first creates. `local root = S.ensure("Workspace.CoinRush", "Folder"); local coins = S.ensure("Workspace.CoinRush.Coins", "Folder")`. Never assume a root exists because another agent "should have" made it. Omit the class to accept whatever is there (`S.ensure("Workspace.CoinRush")` returns the Model another agent made, and creates a Folder only when nothing exists); pass it only when your program depends on it, since a mismatch is an error.
2. **Never destroy a shared root, and never `dry_run` a program that touches one.** A `dry_run` (or an error) rolls back everything *your* program created — including a root another agent is already building under. Deletes are `S.destroy` on things you own only ("Deleting things" above).
3. **Split work by paths.** Each agent owns a subtree (`Workspace.CoinRush.Map`, `ServerScriptService.CoinRush.CoinSpawner`, `StarterGui.CoinRushHud`) and writes nowhere else. Cross-agent references go through the contract (attributes on the shared root, `ReplicatedStorage.<Game>` remotes, tags) and are resolved *at runtime* with `WaitForChild` and timeouts, never at build time.
4. **One owner for Workspace-level cleanup.** Pre-existing `SpawnLocation`s, the `Baseplate`, `Lighting` — one agent is named the owner; the others do not touch them.
5. **Idempotent programs.** Re-running a builder reconciles (`S.ensure`, `S.set`, `S.destroy` of only its own stale children) and reports `created: []` the second time. Use `undo_label: "agent:<name>: <what>"` so the human's undo history reads like a log.
6. **Never heredoc Luau.** Every agent writes its program to a file and passes `code_file` / `--code-file` ("Passing Luau safely"). One `args.json` per program keeps parameters out of the code.
7. **Tests own the playtest.** Builders do not start playtests; one tester agent runs `playtest start` → `install` bots → `run_until` → `observe logs dm:"all"` → `stop`, and files findings as paths + assertion names for a fixer. Fixers patch scripts in one undo step (`S.script.get` by range, `loadstring` check before and after).

## Builtin skills

The bridge ships read-only skills (`skills { action: "list" }` marks them `builtin: true`; `get` shows the `params` each expects as `ARGS`):

| Skill | DM | Does |
|---|---|---|
| `settle_physics` | edit | `workspace:StepPhysics` for `seconds` over the unanchored parts under `paths`; returns final positions (one undo step). One physics step per frame, so `seconds/dt` frames of wall time — the skill refuses up front when `timeout_ms` cannot cover it |
| `device_sim` | edit | device simulator `status` / `list` / `set {device, orientation, resolution}` / `reset`; reports unsupported calls instead of failing |
| `profile_scripts` | any | `ScriptProfilerService` for `seconds`, top `top` functions by total time (`supported: false` with a reason when the build refuses) |
| `bulk_attributes` | any | set/clear attributes on every `find` match; `dry: true` previews |
| `insert_asset` | edit | `InsertService:LoadAsset(assetId)` under `parent`, unwrapped (the loader's never-parented wrapper is destroyed — expect the `:Destroy(` warning, it is harmless here) |
| `lighting_preset` | edit | `day` / `night` / `dusk` on Lighting plus `overrides`; returns before/after |
| `list_scripts` | any | every script under `root` with source length and an FNV-1a checksum — compare two DMs cheaply |
| `remote_map` | any | every Remote*/Bindable* instance with its path |

`skills { action: "run", name: "settle_physics", args: { paths: ["Workspace.Crates"], seconds: 3 } }` runs one exactly like `run` (same result shape, `undo_label` defaults to `skill: settle_physics`). Saving a skill with a builtin's name overrides it for you (`overrides_builtin: true`); deleting your override brings the builtin back; the builtins themselves cannot be deleted.

## Scripts and shells

Anything that can run a command can drive Studio through the running bridge without speaking MCP:

```powershell
studio-live call observe '{"what":"status"}'                                  # prints the tool's text; exit 1 on a tool error
studio-live call run --code-file .\build.luau --args-file .\build.args.json    # Luau from a file: no escaping (v1.1)
studio-live call playtest '{"action":"install","dm":"client:1","name":"bot"}' --code-file .\bot.luau
echo '{"code":"return #workspace:GetChildren()"}' | studio-live call run       # stdin JSON (fine for one-liners only)
studio-live call skills '{"action":"run","name":"remote_map"}' --raw           # the whole MCP result as JSON
studio-live sync .\src --once                                                  # mirror src/**/*.luau into the open place once
studio-live sync .\src --pull                                                  # keep mirroring both ways until Ctrl+C
studio-live twin .\copies\arena-test.rbxl                                      # second Studio on a local place file (v1.1)
```

`sync` maps `<dir>/<Service>/<path>/<Name>.server.luau | .client.luau | .luau` to `Script` / `LocalScript` / `ModuleScript` under that service (see `docs/sync.md`); pushed server scripts are hot-patched into a running playtest by default, `--no-hotpatch` turns that off.

`twin` launches a second Roblox Studio process on the given `.rbxl` (newest `RobloxStudioBeta.exe` under `%LOCALAPPDATA%\Roblox\Versions`, then `%ProgramFiles(x86)%\Roblox\Versions`; `--exe <path>` or `STUDIO_LIVE_STUDIO_EXE` names one directly), waits up to 90 s (`--timeout ms`) for its hub to appear in `GET /status`, and prints the new session id and place; a Studio that cannot start or exits first is reported at once with exit 1. From then on **two sessions are connected**: reads use the active one and say so (`session_note`); writes (`run`, `playtest`, `input`, `skills run`) refuse to guess and need `session: "<guid prefix>"`. Naming a session once makes it the active one for later calls. Use the twin for regression runs on a copy while the human keeps editing the original.

## Everyday observations

```json
observe { "what": "tree", "root": "Workspace.Arena", "depth": 1, "fields": ["Position", "Size"], "max": 50 }
observe { "what": "tree", "root": "ServerStorage" }                    // an explicit root is always returned: {path, class, name, n: 0} when empty (v1.1)
observe { "what": "find", "root": "Workspace", "class": "BasePart", "attr": { "name": "Open" } }
observe { "what": "diff", "since": 10400 }          // what changed in the DataModel since a cursor (instances, not Source edits)
observe { "what": "player", "dm": "client:1" }        // position, velocity, state, health, camera
observe { "what": "logs", "dm": "all", "level": "warn", "tail": 50 }
observe { "what": "script", "path": "ServerScriptService.Main", "from": 1, "to": 60 }
observe { "what": "geometry", "root": "Workspace.Map" }     // overlapping part pairs + parts parented under parts (see "Geometry rules")
observe { "what": "screenshot", "max_width": 800, "format": "jpeg", "quality": 60 }
observe { "what": "screenshot", "region": { "x": 0, "y": 100, "w": 900, "h": 700 }, "max_width": 0 }   // crop, no resize
```

`run` change counts and the throttled `change` events ignore engine-internal trees (`CoreGui`, `CorePackages`, `RobloxReplicatedStorage`, `VoiceChatInternal`, `PluginGuiService`, `RobloxPluginGuiService`, `Stats`, anything named `RobloxReplicated*`) **(v1.1)** — a client run that reported `changes.added: 1` for `VoiceChatInternal` was the engine, not you.

`screenshot` never enters Studio: the bridge captures the Studio window with Win32 `PrintWindow` (≈40 ms, works while occluded). If the window is minimized the bridge restores it without stealing focus (`restore: true`, default) — a `minimized` error means that failed. `no_window` means no Studio window is visible; `title_match` selects among several Studio processes and `hwnd` (from `observe { what: "windows" }`) pins one.

Two Studio windows open (a twin, or a second place)? Each is a separate session. Reads use the active one and say so (`session_note`); writes (`run`, `playtest`, `input`, `skills run`) refuse to guess and require `session: "<guid prefix>"`. Naming a session once makes it the active one for later calls.

## Looking without seeing: `look`

```json
look { "question": "List any red or yellow lines in the Output panel verbatim; say 'none' if there are none.", "region": { "x": 0, "y": 900, "w": 1600, "h": 260 } }
look { "watch": { "question": "One line: is the character standing, walking, falling, or stuck inside geometry?", "interval_s": 4, "max_frames": 45, "stop_when": "/falling|stuck/i" } }
look { "list": true }        // watches with their last answer — the polling fallback when Monitor is off
look { "stop": "all" }
```

A one-shot `look` answers `{ answer, model, provider, usage, frame_path, … }` in 1–4 s on the API; a watch emits one `vision` event per analysed frame on the `/events` socket (`vision` is a default kind) and a final `{ done: true, reason }`. Coordinates in answers are estimates in screenshot pixels. `look` needs either a Claude credential in the bridge's environment (`ANTHROPIC_API_KEY` or a profile) or a logged-in Claude Code install, and reports `auth` when it has neither; the capture errors are the same as `observe screenshot`'s. Details and cost rules of thumb: [vision.md](vision.md).

No API key on the machine? `look` also works through the user's Claude Code login: with `claude` on the bridge's PATH and no credential, the sidecar runs `claude -p` per frame on the subscription (`STUDIO_LIVE_VISION_PROVIDER=auto`, the default; `api` / `claude-cli` force one). Expect **~10–15 s per look** instead of ~2 s, a watch `interval_s` of at least **15** (smaller values are raised, and the start result says so in `interval_clamped` and `note`), `model: "claude-cli:sonnet"` (`haiku` for watches; aliases or full ids via `model` or the env vars), and `usage: { cost_usd, turns }` that counts against the plan's usage limits rather than an API bill. Read `provider` (`"api"` | `"claude-cli"`) in the answer or event before assuming latency: a watch on the CLI is a slow observer, so ask coarser questions, lean on `stop_when`, and keep `max_frames` small.

### look vs observe

| You want to know | Use | Why |
|---|---|---|
| where something is, what a property holds, whether an instance/script exists, what a log said | `observe` (`tree`, `props`, `find`, `script`, `logs`, `player`) or a `run` | exact, milliseconds, no tokens spent on pixels |
| whether the scene *looks* right (lighting, materials, UI overlap, z-fighting, a texture that failed to load) | `look { question }` | only pixels know; the answer is text |
| whether Studio itself shows something (a dialog, an error toast, the Output panel) | `look` with a `region` | outside the DataModel entirely |
| a change over time you cannot express as a predicate (flicker, a character visibly stuck) | `look { watch }` | streams `vision` events; unchanged frames are free |
| something you need to *see* yourself (layout you will hand-tune) | `observe screenshot` | costs ~1 100 tokens per turn it stays in context |

Rule: state → `observe`; appearance → `look`; verify anything `look` tells you that you will act on with an `observe` read before acting.

## Open Cloud for the open place: `cloud`

```json
cloud { "action": "info", "what": "key" }
cloud { "action": "info", "what": "universe" }
cloud { "action": "datastore", "op": "get", "store": "PlayerData", "key": "p_100000001" }
cloud { "action": "memory", "op": "map_set", "store": "Lobby", "key": "p_1", "value": { "mmr": 1500 }, "sort_key": 1500, "ttl_s": 300 }
cloud { "action": "message", "topic": "Announce", "message": { "kind": "reload" } }
cloud { "action": "publish", "file": "C:\\places\\game.rbxl" }
cloud { "action": "luau", "script": "return #workspace:GetDescendants()" }
cloud { "action": "asset", "op": "update", "asset_id": 5551234, "file": "C:\\art\\logo_v2.png" }
```

### What the key can do: ask first

`info what:"key"` reads the key's own scope list from Roblox's key introspection endpoint and reports every capability as `allowed`, `denied` or `unknown`, each with the permission to add — writes included, and nothing is called to find out (`method: "introspect"`). `bound_to_this_universe: false` means the key was never given this experience at all: one fix in Creator Hub, not a dozen. If introspection is unavailable the report falls back to trial reads against reserved names (`method: "probe"`), which cannot settle writes; `deep: true` adds the harmless ones that can. `unknown` on `info group` / `info user` / `info inventory` is expected: Roblox refuses group-owned keys there whatever their scopes.

### The published place is not the open place

`luau` and `instance` read the **published** place. After editing in Studio, have the human save the place to a file (File → Save to File As…) and `cloud publish` it, then read it back. The save cannot be automated: no Studio API saves a place (`game:SavePlace` is server-only, and `SerializationService` refuses services). `publish` checks the file's bytes (a non-place file is refused before upload), goes live by default (`version_type: "Saved"` stores a version without publishing), and lists in `not_updated_by_this_api` the instance types the publish API silently does not carry — unions (`PartOperation`), `EditableMesh` / `EditableImage`, `SurfaceAppearance`, `BaseWrap`; if the place uses them, publish from Studio instead. A `409` on publish usually means the place is busy — open in Studio or in Team Create — not that the ids are wrong.

`instance update` writes only `Folder`, `Script`, `LocalScript` and `ModuleScript` (and only `Source` / `Enabled` / `RunContext`); everything else goes through `run` and a publish. Every Instance API call is long-running, reads included.

### The rest, briefly

- `asset_upload` mints a new id every time; `asset update` puts a new version behind an **existing** id — FBX-based Models only, since Roblox refuses content updates for images, audio, meshes and video — so every `rbxassetid://` already placed in the game picks it up. `asset rollback` / `archive` / `restore` complete the lifecycle (there is no delete, and Models cannot be archived).
- `memory` sorted maps and queues are live cross-server state with a `ttl_s`. Sorted map writes replace the whole item. A queue read hides items for `invisibility_s` rather than removing them; `queue_discard` with the returned `read_id` acknowledges the batch. There is no sorted-map increment in Open Cloud, and the universe-wide `flush` is deliberately not exposed.
- `restriction ban` bans from the whole experience unless you pass `level: "place"` — never inferred from the session's place id. Omit `duration_s` for a permanent ban; `unban` lifts it.
- `notify` sends an experience notification using a notification string made in Creator Hub (`message_id`). Roblox refuses players who have not opted in (`not_opted_in: true`); they opt in from inside the experience via `ExperienceNotificationService:PromptOptIn`.

### How ids are inferred

1. Explicit `universe_id` / `place_id` / `creator` in the call always win (`ids_from: "args"`, or `"mixed"` when only some were given).
2. Otherwise the ids of the connected session are used (`ids_from: "studio"`): `placeId` and `placeName` come from the hub's `hello`; `universeId` (`game.GameId`), `creatorType` (`User` | `Group`) and `creatorId` arrive with the hub's **first heartbeat**, a second or so after connect. A call in that first second gets a distinct `no_ids` "not known yet" message — retry once. An unpublished place (`PlaceId 0`) gets "publish it first".
3. With two Studios connected, `session` picks whose ids are used, exactly as for every other tool.

The key is read from disk on every call (`ROBLOX_OPEN_CLOUD_KEY`, `<STUDIO_LIVE_HOME>/opencloud.json`, `<STUDIO_LIVE_HOME>/opencloud.key`) and a `403` names the exact Creator Hub permission to add. Actions, limits and error codes: [cloud.md](cloud.md).

## Long operations

A tool call that is still running after `wait_ms` (default 25 s) returns `{ job_id: "r-3f9a1c-17", status: "running", op, dm, elapsed_ms, progress }` while the program keeps running in Studio. `job { action: "wait", job_id, wait_ms: 50000 }` returns the result (`status: "done"`, `result`) or the still-running snapshot; `job { action: "status", job_id }` is the non-blocking version; `job { action: "cancel", job_id }` stops cooperative work at the next `S.yield()`/`S.wait()` and the job ends with `error.code: "cancelled"`; `job { action: "list" }` finds an id you lost. Jobs survive Studio's periodic socket refresh (`hub_connected: false` while it is away) and a `job` event arrives on the push stream when a job that ran more than 5 s finishes. Keep any single tool call under 50 s; Claude Code backgrounds calls that exceed 120 s. Inside a program, `S.remaining()` is the seconds left before the deadline — size loops by it instead of being cut off and rolled back.

## Reference: the `S` API you get everywhere

Query: `S.get(path)`, `S.path(inst)`, `S.find{root?,name?,class?,tag?,attr?,max?}`, `S.tree(inst, depth)`, `S.props(inst, names?)` (unreadable properties omitted), `S.raycast`, `S.overlap`, `S.distance`.
Build: `S.new(class, props?, parent?)` (props may hold `Attributes = {…}`, `Tags = {…}` and `PlaceOn = target`), `S.ensure(path, class, props?)` (create-if-missing, returns the existing instance, participates in the recording — **v1.1**), `S.set` / `S.batchSet` (unwritable properties collected into the response's `unwritable` instead of throwing — **v1.1**), `S.clone`, `S.destroy` (edit DM: `Parent = nil`, undoable — **v1.1**), `S.part(props)` (anchored, smooth plastic by default), `S.model(name, children, parent)`, `S.grid{origin, cols, rows, step, make(i, j)}`, `S.box{…}`, `S.ui.screen/frame/text/button`.
Placement (see "Geometry rules"): `S.placeOn(part, target, {align, gap})` (rests a part or Model on top of another), `S.fits(cframe, size, {ignore, tolerance}) -> ok, blockers`, `S.overlaps(instOrList, opts) -> {…}` (the run report's entries), `S.snapToGrid(part, step)`.
Scripts: `S.script.get(path, {from?, to?}?)` (line ranges, whole sources exempt from the 8 KB cap — **v1.1**), `S.script.set/patch/restart/create`.
Play DMs: `S.pathTo(pos, timeout?)` (**v1.1**, PathfindingService; blocks until it returns, reasons in "Walking") next to the controller `ctx.pathTo`. `observe { what: "script" }` pages on whole lines with `next_from`; a single line longer than the budget comes back cut with `line_cut: true` and `next_from` unchanged — stop paging and use `response_format: "detailed"` or `S.script.get(path, { from, to })` with `string.sub`.
Everywhere: `S.emit(name, data?)` → `custom` event, `S.log(msg)`, `S.yield()`, `S.wait(seconds)`, `S.remaining()`, `S.json(value)`, `S.role`, `S.dm`, `S.clock()`.
Controllers get `ctx` with `ctx.S`, `ctx.assert/milestone/emit/log`, `ctx.onHeartbeat/onEvent/every/after`, `ctx.player/character/input/moveTo/pathTo/state`, `ctx.storage` (survives reinstall).

`run` response: `{ value, output[], duration_ms, changes{added, removed, paths}, undo, ephemeral, dm, warnings?, detached?, unwritable?, geometry? }` — `warnings` lists things like `program calls :Destroy( …` (edit DM) and the geometry lines, `detached` counts the instances `S.destroy` un-parented in this program (edit DM), `unwritable` the `{path, prop, reason}` properties `S.set` could not write, `geometry` the `{overlaps, nested, checked, sampled?, ms, totals}` report of the parts this run added ("Geometry rules"); all four are omitted when empty. With `geometry_policy: "reject"` a non-empty report is instead `error.code: "geometry_violation"` (carrying `geometry`, `warnings`, `undo: "cancelled"`, `output`) and the run is rolled back. `response_format: "detailed"` adds `flush` (`immediate` | `deferred` | `frame`: how the change counts were flushed).

Values come back JSON-safe (§7): `Instance` → `{"$i": "Workspace.Arena.Door", "class": "Part"}`, `Vector3` → `[x, y, z]`, `CFrame` → `{p, look}`, `Color3` → `"#rrggbb"`, enums → `"Enum.Material.Plastic"`.
