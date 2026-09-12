--[[
	`selftest` op (hub): exercises serialize / paths / chunking / journal / dispatcher / logs /
	persist and the S API inside a cancelled ChangeHistory recording.
	Returns { ok, checks = [{name, ok, detail?}] }.
]]

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local CollectionService = game:GetService("CollectionService")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local Dispatcher = require(script.Parent.Parent.shared.dispatcher)
local geometry = require(script.Parent.Parent.shared.geometry)
local Journal = require(script.Parent.Parent.shared.journal)
local Logs = require(script.Parent.Parent.shared.logs)
local observe = require(script.Parent.Parent.shared.observe)
local paths = require(script.Parent.Parent.shared.paths)
local protocol = require(script.Parent.Parent.shared.protocol)
local query = require(script.Parent.Parent.shared.query)
local runner = require(script.Parent.Parent.shared.runner)
local serialize = require(script.Parent.Parent.shared.serialize)
local util = require(script.Parent.Parent.shared.util)

local Persist = require(script.Parent.persist)

local selftest = {}

local FOLDER_NAME = "StudioLiveSelftest"
-- Created outside the recording (untracked) so S.destroy's restore-on-Cancel can be observed.
local PRE_FOLDER_NAME = "StudioLiveSelftestPre"
-- Geometry checks build far above anything a place is likely to hold (a Baseplate sits near y = 0).
local GEO_Y = 5000

type Check = { name: string, ok: boolean, detail: string? }

-- `env` (the hub's Env) lets observe.script read through the editor buffer like the real op.
export type Extras = { env: any? }

-- Drives a private dispatcher through the write-queue contract: FIFO order, reads never wait,
-- a queued request times out on its own deadline, cancels at once, and gets one
-- "queued behind N" progress frame after 250 ms.
local function writeQueueCheck(): (boolean, string?)
	local sent: { { [string]: any } } = {}
	local order: { string } = {}
	local d = Dispatcher.new("selftest", function(frame)
		table.insert(sent, frame)
	end, nil)
	d:register("w", function(req)
		table.insert(order, req.id .. ":start")
		if type(req.body.hold) == "number" and req.body.hold > 0 then
			task.wait(req.body.hold)
		end
		table.insert(order, req.id .. ":end")
		return { id = req.id }
	end, true)
	d:register("r", function(req)
		table.insert(order, req.id .. ":read")
		return {}
	end)
	d:handle({ v = 1, kind = "req", id = "a", op = "w", body = { hold = 0.4 } })
	d:handle({ v = 1, kind = "req", id = "b", op = "w", body = {} })
	d:handle({ v = 1, kind = "req", id = "c", op = "w", deadline_ms = 100, body = {} })
	d:handle({ v = 1, kind = "req", id = "d", op = "w", body = {} })
	d:handle({ v = 1, kind = "req", id = "e", op = "r", body = {} })
	d:handle({ v = 1, kind = "cancel", id = "d" })

	local function response(id: string): { [string]: any }?
		for _, f in ipairs(sent) do
			if f.kind == "res" and f.id == id then
				return f
			end
		end
		return nil
	end
	local function progressNote(id: string): string?
		for _, f in ipairs(sent) do
			if f.kind == "progress" and f.id == id then
				return f.note
			end
		end
		return nil
	end
	local function indexOf(step: string): number
		for i, s in ipairs(order) do
			if s == step then
				return i
			end
		end
		return math.huge
	end

	local deadline = os.clock() + 3
	while os.clock() < deadline and not (response("a") and response("b") and response("c") and response("d") and response("e")) do
		task.wait(0.05)
	end
	local a, b, c, dd, e = response("a"), response("b"), response("c"), response("d"), response("e")
	local detail = ("order=%s notes(b)=%s queue=%d active=%s"):format(table.concat(order, ","), tostring(progressNote("b")), d:queued(), tostring(d.activeWrite))
	d:stop()
	if not (a and b and c and dd and e) then
		return false, "missing responses; " .. detail
	end
	local function errCode(f: { [string]: any }): string?
		return if type(f.error) == "table" then f.error.code else nil
	end
	local fifo = indexOf("a:start") < indexOf("e:read") and indexOf("e:read") < indexOf("a:end") and indexOf("a:end") < indexOf("b:start")
	local neverRan = indexOf("c:start") == math.huge and indexOf("d:start") == math.huge
	local codes = a.ok == true and b.ok == true and errCode(c) == "timeout" and errCode(dd) == "cancelled" and e.ok == true
	local noticed = progressNote("b") == "queued behind 1" and progressNote("a") == nil
	local drained = d:queued() == 0 and d.activeWrite == nil
	return fifo and neverRan and codes and noticed and drained, detail
end

-- Counts Heartbeats while `fn` runs.
local function framesDuring(fn: () -> ()): number
	local frames = 0
	local conn = RunService.Heartbeat:Connect(function()
		frames += 1
	end)
	local ok, err = pcall(fn)
	conn:Disconnect()
	if not ok then
		error(err, 0)
	end
	return frames
end

-- L3: a burst of queued writes whose handlers each yield once must drain several per frame, with
-- the frame yield inserted only once the 8 ms slice is used up.
local function drainCheck(): (boolean, string?)
	local sent = 0
	local d = Dispatcher.new("selftest-drain", function(frame)
		if frame.kind == "res" then
			sent += 1
		end
	end, nil)
	-- Each handler costs a deferred hop (what runner.flushDeferred costs) rather than a frame.
	local n = 40
	local starts: { [number]: boolean } = {}
	d:register("w", function(_req, ctl)
		-- Launches within one frame share the burst's slice start (S.yield measures from it).
		if type(ctl.sliceStart) == "number" then
			starts[ctl.sliceStart :: number] = true
		end
		local thread = coroutine.running()
		task.defer(function()
			pcall(task.spawn, thread)
		end)
		coroutine.yield()
		return {}
	end, true)
	local frames = framesDuring(function()
		for i = 1, n do
			d:handle({ v = 1, kind = "req", id = ("q%d"):format(i), op = "w", body = {} })
		end
		local deadline = os.clock() + 3
		while sent < n and os.clock() < deadline do
			task.wait()
		end
	end)
	local queued = d:queued()
	d:stop()
	local distinct = 0
	for _ in pairs(starts) do
		distinct += 1
	end
	-- One frame per write would be 40; the drain should need only a handful even on a slow machine.
	-- Distinct slice starts = launch bursts, at most one per frame the drain spanned.
	return sent == n and queued == 0 and frames <= 8 and distinct >= 1 and distinct <= frames + 1, ("responses=%d/%d frames=%d bursts=%d"):format(sent, n, frames, distinct)
end

local function persistChecks(check: (string, () -> (boolean, string?)) -> ())
	check("persist.registry", function()
		local p = Persist.new(function() end)
		p:remember("server", "alpha", "return 1")
		p:remember("client", "beta", "return 2") -- "client" is the first client
		p:remember("server", "alpha", "return 3") -- replaces, moves to the end
		p:remember("client:2", "gamma", "return 4")
		local forgot = p:forget("client:1", "beta")
		local order = {}
		for _, e in ipairs(p.entries) do
			table.insert(order, e.dm .. "/" .. e.name)
		end
		local a = p:get("server", "alpha")
		local listed = p:list()
		return forgot and #p.entries == 2 and order[1] == "server/alpha" and order[2] == "client:2/gamma" and a ~= nil and a.code == "return 3" and #p:forDm("client:1") == 0 and listed[1].source == "bridge" and listed[1].bytes == 8, table.concat(order, ",")
	end)
	check("persist.sync", function()
		-- persist_sync replaces (never merges): an entry the bridge no longer lists is gone,
		-- malformed entries are counted, "client" is normalised, the last duplicate wins.
		local p = Persist.new(function() end)
		p:remember("server", "stale", "return 0")
		local accepted, rejected = p:replaceAll({
			{ dm = "server", name = "one", code = "return 1" },
			{ dm = "client", name = "two", code = "return 2" },
			{ dm = "bogus", name = "x", code = "return 3" },
			{ dm = "server", name = "one", code = "return 11" },
			"not a table",
		})
		local one = p:get("server", "one")
		return accepted == 2 and rejected == 2 and p:get("server", "stale") == nil and one ~= nil and one.code == "return 11" and #p:forDm("client:1") == 1 and p:count() == 2, ("accepted=%d rejected=%d count=%d"):format(accepted, rejected, p:count())
	end)
end

-- Splits, decodes and reassembles `text`; returns the round-tripped text (nil when any step fails).
local function roundTripChunks(text: string, limit: number): (string?, number)
	local pieces = protocol.chunkSplit(text, limit)
	if pieces == nil then
		return nil, 0
	end
	local asm = protocol.newAssembler()
	local whole: string? = nil
	for _, piece in ipairs(pieces) do
		local frame = util.safeJsonDecode(piece)
		if frame == nil then
			return nil, #pieces
		end
		whole = asm:feed(frame) or whole
	end
	return whole, #pieces
end

local function runChecks(makeS: () -> any, journal: any?, extras: Extras?): { Check }
	local checks: { Check } = {}
	local function check(name: string, fn: () -> (boolean, string?))
		local ok, pass, detail = pcall(fn)
		if not ok then
			table.insert(checks, { name = name, ok = false, detail = tostring(pass) })
		else
			table.insert(checks, { name = name, ok = pass == true, detail = detail })
		end
	end
	local env = if extras then extras.env else nil

	check("dispatcher.writeQueue", writeQueueCheck)
	check("dispatcher.drain", drainCheck)
	persistChecks(check)

	check("serialize.vector3", function()
		local v = serialize.value(Vector3.new(1, 2, 3))
		return v[1] == 1 and v[2] == 2 and v[3] == 3, util.safeJsonEncode(v)
	end)
	check("serialize.cframe", function()
		local v = serialize.value(CFrame.new(1, 2, 3))
		local d = serialize.value(CFrame.new(1, 2, 3), { detailed = true })
		return type(v.p) == "table" and type(v.look) == "table" and v.c == nil and #d.c == 12, util.safeJsonEncode(v)
	end)
	check("serialize.color3", function()
		local v = serialize.value(Color3.new(1, 0, 0))
		return v == "#ff0000", v
	end)
	check("serialize.enum", function()
		local v = serialize.value(Enum.Material.Plastic)
		return v == "Enum.Material.Plastic", v
	end)
	check("serialize.udim2", function()
		local v = serialize.value(UDim2.new(0.5, 10, 1, -4))
		return v[1] == 0.5 and v[2] == 10 and v[3] == 1 and v[4] == -4, util.safeJsonEncode(v)
	end)
	check("serialize.cycle", function()
		local t: { [string]: any } = { a = 1 }
		t.self = t
		local v = serialize.value(t)
		return v.self == "<cycle>" and v.a == 1, util.safeJsonEncode(v)
	end)
	check("serialize.longString", function()
		local v = serialize.value(string.rep("x", 10000))
		return #v < 10000 and string.find(v, "…[+", 1, true) ~= nil, ("len=%d"):format(#v)
	end)
	check("serialize.longStringUtf8", function()
		-- Every cut position lands inside a 3-byte character unless the cut is boundary-aware.
		local v = serialize.value(string.rep("…", 4000))
		return utf8.len(v) ~= nil and util.safeJsonEncode(v) ~= nil, ("len=%d"):format(#v)
	end)
	check("util.truncateUtf8", function()
		local s = "ab" .. string.rep("→", 100)
		for max = 24, 60 do
			local t = util.truncate(s, max)
			if utf8.len(t) == nil or #t > max then
				return false, ("max=%d len=%d"):format(max, #t)
			end
		end
		return true
	end)
	check("util.sliceLines", function()
		local text, total, from, to = util.sliceLines("l1\nl2\nl3\nl4\nl5", 2, 3)
		local tail, total2, from2, to2 = util.sliceLines("l1\nl2\nl3", 3)
		local empty, _, from3, to3 = util.sliceLines("l1\nl2", 5, 9)
		return text == "l2\nl3" and total == 5 and from == 2 and to == 3 and tail == "l3" and total2 == 3 and from2 == 3 and to2 == 3 and empty == "" and from3 == 5 and to3 == 4, ("%q %q %q"):format(text, tail, empty)
	end)
	check("serialize.buffer", function()
		local v = serialize.value(buffer.create(4))
		return v["$buf"] == 4, util.safeJsonEncode(v)
	end)
	check("serialize.instance", function()
		local v = serialize.value(Workspace)
		return v["$i"] == "Workspace" and v.class == "Workspace", util.safeJsonEncode(v)
	end)
	check("serialize.function", function()
		return serialize.value(print) == "<function>"
	end)
	check("paths.resolve", function()
		local a, b, c = paths.resolve("game.Workspace"), paths.resolve("Workspace"), paths.resolve("workspace")
		return a == Workspace and b == Workspace and c == Workspace
	end)
	check("paths.service", function()
		return paths.resolve("game.Lighting") == game:GetService("Lighting")
	end)
	check("protocol.chunks", function()
		local big = string.rep("abcdefgh", 8000)
		local whole, n = roundTripChunks(big, protocol.CHUNK_L2)
		return n > 1 and whole == big, ("%d pieces"):format(n)
	end)
	check("protocol.chunksUtf8", function()
		-- Shift a run of 3-byte characters across every offset near the slice size so some
		-- byte-based cut would land inside a character; each piece must still JSON-encode.
		local slice = math.floor(protocol.CHUNK_L2 * 0.75)
		for offset = 0, 8 do
			local text = string.rep("a", slice - 6 + offset) .. string.rep("…", 8) .. string.rep("b", slice)
			local whole, n = roundTripChunks(text, protocol.CHUNK_L2)
			if whole ~= text then
				return false, ("offset %d: %d pieces, round trip %s"):format(offset, n, if whole then "mismatch" else "failed")
			end
		end
		return true
	end)
	check("json.roundtrip", function()
		local text = util.safeJsonEncode({ a = { 1, 2, 3 }, b = "x" })
		local back = if text then util.safeJsonDecode(text) else nil
		return back ~= nil and back.b == "x" and back.a[3] == 3
	end)
	check("query.propsOmitsUnreadable", function()
		-- Workspace has no Size: the field is left out instead of an "<unreadable>" placeholder.
		local props = query.props(Workspace, { "Name", "Size" }).props
		return props.Name == "Workspace" and props.Size == nil, util.safeJsonEncode(props)
	end)
	check("query.findSkipsInternals", function()
		-- A whole-DataModel search never reaches Stats (naming it as root still does).
		local hidden = query.find({ class = "StatsItem", max = 5 })
		local explicit = query.find({ root = "Stats", class = "StatsItem", max = 5 })
		return #hidden == 0, ("game: %d, root=Stats: %d"):format(#hidden, #explicit)
	end)
	check("query.treeExplicitRoot", function()
		-- F9: an explicit root is always returned, even an empty service (n = 0), while a
		-- whole-DataModel tree still omits empty services.
		local empty: Instance? = nil
		for _, svc in ipairs(game:GetChildren()) do
			local ok, n = pcall(function()
				return #svc:GetChildren()
			end)
			if ok and n == 0 then
				empty = svc
				break
			end
		end
		if empty == nil then
			return true, "skipped: no empty service in this place"
		end
		local explicit = query.tree(empty, 1, {})
		local whole = query.tree(game, 0, { max = 20000 })
		local listed = false
		for _, node in ipairs(whole.nodes) do
			if node.path == paths.of(empty) then
				listed = true
			end
		end
		-- The class filter applies to descendants only: the root itself is returned even when it does not match.
		local filtered = query.tree(Workspace, 0, { classes = { "BasePart" } })
		local rootKept = #filtered.nodes == 1 and filtered.nodes[1].path == "Workspace"
		return #explicit.nodes == 1 and explicit.nodes[1].n == 0 and explicit.nodes[1].path == paths.of(empty) and not listed and rootKept, ("root=%s explicit=%d listedInGameTree=%s rootWithClasses=%d"):format(paths.of(empty), #explicit.nodes, tostring(listed), #filtered.nodes)
	end)
	check("journal.ignoresInternal", function()
		-- L4: engine / Studio-internal trees never reach the change journal — services, their
		-- descendants, and (via the remembered parent) their descendants once detached.
		local j = Journal.new(16)
		local stats = game:GetService("Stats")
		j:record("added", game:GetService("CoreGui"))
		j:record("added", stats)
		local statsChild = stats:GetChildren()[1]
		if statsChild then
			j:record("added", statsChild)
		end
		local ghost = Instance.new("Folder")
		ghost.Name = "StudioLiveSelftestGhost"
		j.parents[ghost] = stats -- what a DescendantAdded under Stats would have remembered
		j:record("removed", ghost)
		local internalSeq = j.seq
		j:record("added", Workspace)
		local names = Journal.isIgnoredName("RobloxReplicatedStorage") and Journal.isIgnoredName("RobloxReplicatedFoo") and Journal.isIgnoredName("VoiceChatInternal") and not Journal.isIgnoredName("Workspace") and not Journal.isIgnoredName("ReplicatedStorage")
		return internalSeq == 0 and j.seq == 1 and names, ("internalSeq=%d afterWorkspace=%d statsChild=%s"):format(internalSeq, j.seq, tostring(statsChild ~= nil))
	end)
	check("journal.removedAfterDetach", function()
		-- Deferred signal behaviour runs DescendantRemoving after the parent change: a detached instance
		-- must still be counted, with the path it had, from the parent remembered at its Added.
		local j = Journal.new(16)
		local f = Instance.new("Folder")
		f.Name = "StudioLiveSelftestDetach"
		f.Parent = Workspace
		local child = Instance.new("Folder")
		child.Name = "Inner"
		child.Parent = f
		j:record("added", f)
		j:record("added", child)
		f.Parent = nil
		j:record("removed", f)
		j:record("removed", child)
		-- An instance never seen attached is still counted, under its own name.
		local stranger = Instance.new("Folder")
		stranger.Name = "StudioLiveSelftestStranger"
		j:record("removed", stranger)
		local items = j.ring:since(0)
		local removedRoot = items[3]
		local removedChild = items[4]
		local ok = j.seq == 5 and removedRoot ~= nil and removedRoot.kind == "removed" and removedRoot.path == "Workspace.StudioLiveSelftestDetach" and removedChild ~= nil and removedChild.path == "Workspace.StudioLiveSelftestDetach.Inner" and items[5] ~= nil and items[5].path == "StudioLiveSelftestStranger"
		f:Destroy()
		stranger:Destroy()
		return ok, ("seq=%d root=%s child=%s"):format(j.seq, tostring(if removedRoot then removedRoot.path else nil), tostring(if removedChild then removedChild.path else nil))
	end)
	check("logs.dmAll", function()
		-- F5: dm "all" (or none) returns every DM's lines; a named dm filters; history is flagged.
		local l = Logs.new("edit")
		l:record({ seq = 1, t = 0, wall = 10, level = "print", msg = "one", src = "edit" })
		l:record({ seq = 2, t = 0, wall = 11, level = "print", msg = "two", src = "server", history = true })
		l:record({ seq = 3, t = 0, wall = 12, level = "warn", msg = "three", src = "client:1" })
		local all = l:query({ dm = "all" })
		local server = l:query({ dm = "server" })
		local none = l:query({})
		return #all.items == 3 and all.next == 3 and #server.items == 1 and server.items[1].history == true and #none.items == 3, ("all=%d server=%d none=%d"):format(#all.items, #server.items, #none.items)
	end)
	check("logs.historyDedupe", function()
		-- F4: a client's history line that repeats a journaled *server* line (same level + text, wall
		-- within 2 s) is dropped; identical repeats from one DM and a client's own line survive because
		-- the hub only matches against src "server".
		local l = Logs.new("edit")
		l:record({ seq = 1, t = 0, wall = 100, level = "print", msg = "[CoinSpawner] 20 coins", src = "server" })
		l:record({ seq = 2, t = 0, wall = 100, level = "print", msg = "client only", src = "client:1" })
		local same = l:hasSimilar({ level = "print", msg = "[CoinSpawner] 20 coins", wall = 101, history = true }, nil, "server")
		local later = l:hasSimilar({ level = "print", msg = "[CoinSpawner] 20 coins", wall = 130, history = true }, nil, "server")
		local other = l:hasSimilar({ level = "warn", msg = "[CoinSpawner] 20 coins", wall = 100, history = true }, nil, "server")
		local clientOwn = l:hasSimilar({ level = "print", msg = "client only", wall = 100, history = true }, nil, "server")
		local anySrc = l:hasSimilar({ level = "print", msg = "client only", wall = 100, history = true })
		-- Two consecutive identical server history lines: the second is journaled too (the hub never
		-- checks server lines), so the journal ends up holding both.
		l:record({ seq = 3, t = 0, wall = 100, level = "print", msg = "coin spawned", src = "server", history = true })
		l:record({ seq = 4, t = 0, wall = 100, level = "print", msg = "coin spawned", src = "server", history = true })
		local both = #l:query({ dm = "server", filter = "coin spawned" }).items == 2
		return same and not later and not other and not clientOwn and anySrc and both, ("same=%s later=%s other=%s clientOwn=%s anySrc=%s both=%s"):format(tostring(same), tostring(later), tostring(other), tostring(clientOwn), tostring(anySrc), tostring(both))
	end)

	-- Instance checks run inside a recording that is always cancelled. `pre` exists before the
	-- recording so S.destroy's restore-on-Cancel can be verified (F2); it is removed for real after.
	-- ChangeHistory can only restore instances it tracks: ones present at place load or created inside a
	-- recording (every agent `run` is one). A folder created by a bare Instance.new outside any recording
	-- is invisible to a later recording's Cancel — measured live — so `pre` is created the way real
	-- programs create things: in its own committed recording, one frame before the test recording.
	local pre = Instance.new("Folder")
	pre.Name = PRE_FOLDER_NAME
	local okPre, preRec = pcall(ChangeHistoryService.TryBeginRecording, ChangeHistoryService, "StudioLive", "selftest setup")
	pre.Parent = Workspace
	if okPre and type(preRec) == "string" then
		pcall(ChangeHistoryService.FinishRecording, ChangeHistoryService, preRec, Enum.FinishRecordingOperation.Commit)
	end
	task.wait()
	local okRec, rec = pcall(ChangeHistoryService.TryBeginRecording, ChangeHistoryService, "StudioLive", "selftest")
	local recording = if okRec and type(rec) == "string" then rec else nil
	table.insert(checks, { name = "undo.recording", ok = recording ~= nil, detail = if recording then nil else "unavailable (playtest running or another recording open)" })
	local S = makeS()
	local folder: Instance? = nil
	check("S.new", function()
		folder = S.new("Folder", { Name = FOLDER_NAME, Attributes = { k = 1 }, Tags = { "studio-live-selftest" } }, Workspace)
		local f = folder :: Instance
		return f.Parent == Workspace and f:GetAttribute("k") == 1 and CollectionService:HasTag(f, "studio-live-selftest")
	end)
	check("paths.dottedName", function()
		local part = S.part({ Name = "a.b", Parent = folder })
		local p = paths.of(part)
		return p == 'Workspace.StudioLiveSelftest["a.b"]' and paths.resolve(p) == part, p
	end)
	check("S.set", function()
		local part = (folder :: Instance):FindFirstChild("a.b") :: Part
		S.set(part, { Transparency = 0.5, Attributes = { hp = 3 } })
		return part.Transparency == 0.5 and part:GetAttribute("hp") == 3
	end)
	check("S.set.unwritable", function()
		-- F8: a member the plugin VM cannot write ("not a valid member" / "lacking capability" — the
		-- engine words a misspelt name the same way) is reported in S.unwritable, the rest is applied;
		-- a bad value for a real property still throws. (The engine silently coerces a non-numeric string
		-- assigned to a number property to 0 — measured live — so the bad value must be a type it rejects.)
		local part = (folder :: Instance):FindFirstChild("a.b") :: Part
		S.set(part, { Transparency = 0.25, StudioLiveNotAMember = 1 })
		local entry = S.unwritable[1]
		local okBad = pcall(S.set, part, { Size = "not a vector" })
		return part.Transparency == 0.25 and entry ~= nil and entry.prop == "StudioLiveNotAMember" and not okBad, if entry then entry.reason else "no entry"
	end)
	check("run.unwritableWarning", function()
		-- The run body mirrors a non-empty `unwritable` into `warnings`, so a builder that skips the
		-- list still sees that a property (gated or misspelt) was not applied.
		local body, err = runner.run({
			code = "S.set(ARGS.part, { StudioLiveStillNotAMember = 2 }); return true",
			args = { part = (folder :: Instance):FindFirstChild("a.b") },
			S = S,
			journal = nil,
			ephemeral = false,
		})
		if body == nil then
			return false, tostring(if type(err) == "table" then err.message else err)
		end
		local w = if type(body.warnings) == "table" then body.warnings[1] else nil
		local found = false
		for _, e in ipairs(body.unwritable or {}) do
			if e.prop == "StudioLiveStillNotAMember" then
				found = true
			end
		end
		return found and type(w) == "string" and string.find(w, "could not be written", 1, true) ~= nil and string.find(w, "StudioLiveStillNotAMember", 1, true) ~= nil, tostring(w)
	end)
	check("S.ensure", function()
		-- F10: creates the missing chain (Folders above, the class at the leaf, props on the new leaf),
		-- returns the existing instance afterwards, refuses a class mismatch only when a class was
		-- given (S.ensure(path) accepts whatever another agent created there).
		local leafPath = "Workspace." .. FOLDER_NAME .. ".Deep.Leaf"
		local leaf, created = S.ensure(leafPath, "Part", { Anchored = true, Attributes = { made = true } })
		local again, createdAgain = S.ensure(leafPath, "Part", { Anchored = false })
		local deep = (folder :: Instance):FindFirstChild("Deep")
		local okMismatch = pcall(S.ensure, "Workspace." .. FOLDER_NAME .. ".Deep", "Part")
		local okInst, createdInst = S.ensure(deep, "Folder")
		local noClass, createdNoClass = S.ensure(leafPath)
		local svc, createdSvc = S.ensure("Workspace")
		return created == true and leaf:IsA("Part") and (leaf :: Part).Anchored == true and leaf:GetAttribute("made") == true and again == leaf and createdAgain == false and deep ~= nil and deep:IsA("Folder") and not okMismatch and okInst == deep and createdInst == false and noClass == leaf and createdNoClass == false and svc == Workspace and createdSvc == false, paths.of(leaf)
	end)
	check("S.pathTo.wrongDm", function()
		-- Client-only helpers answer (false, "wrong_dm") on the hub instead of touching PathfindingService.
		local reached, reason = S.pathTo(Vector3.zero, 1)
		local moved, reason2 = S.moveTo(Vector3.zero, 1)
		return reached == false and reason == "wrong_dm" and moved == false and reason2 == "wrong_dm", tostring(reason)
	end)
	check("geometry.overlaps", function()
		-- A block resting on another (shared face) is not an overlap; one sunk 0.5 studs in is, with
		-- that depth (exact SAT for two block Parts); a sunk wedge is reported bounds-based, `approximate`.
		local base = S.part({ Name = "GeoBase", Size = Vector3.new(8, 1, 8), CFrame = CFrame.new(0, GEO_Y, 0), Parent = folder })
		local touching = S.part({ Name = "GeoTouch", Size = Vector3.new(2, 2, 2), CFrame = CFrame.new(0, GEO_Y + 1.5, 0), Parent = folder })
		local sunk = S.part({ Name = "GeoSunk", Size = Vector3.new(2, 2, 2), CFrame = CFrame.new(3, GEO_Y + 1, 0), Parent = folder })
		local wedge = S.new("WedgePart", { Name = "GeoWedge", Anchored = true, Size = Vector3.new(2, 2, 2), CFrame = CFrame.new(-3, GEO_Y + 1, 0), Parent = folder })
		local list, info = geometry.overlaps({ base, touching, sunk, wedge }, { against = "self" })
		local byB: { [string]: any } = {}
		for _, o in ipairs(list) do
			byB[o.b] = o
			byB[o.a] = byB[o.a] or o
		end
		local sunkEntry, wedgeEntry = byB[paths.of(sunk)], byB[paths.of(wedge)]
		-- The whole folder through S (earlier checks left other parts at the origin, so count only GeoBase pairs).
		local viaS = S.overlaps(folder, { against = "self" })
		local basePairs = 0
		for _, o in ipairs(viaS) do
			if o.a == paths.of(base) or o.b == paths.of(base) then
				basePairs += 1
			end
		end
		-- A part listed twice is checked once and its pairs counted once.
		local dup, dupInfo = geometry.overlaps({ base, sunk, base, sunk }, { against = "self" })
		local deduped = #dup == 1 and dupInfo.total == 1 and dupInfo.checked == 2
		local ok = #list == 2 and info.total == 2 and info.checked == 4 and info.sampled == false and byB[paths.of(touching)] == nil and sunkEntry ~= nil and sunkEntry.depth == 0.5 and sunkEntry.approximate == nil and wedgeEntry ~= nil and wedgeEntry.approximate == true and basePairs == 2 and deduped
		return ok, util.safeJsonEncode({ list = list, info = info, viaS = #viaS, dup = dupInfo })
	end)
	check("geometry.touchingGrid", function()
		-- At scale: 400 floor tiles edge to edge plus 100 tiles resting on them share faces everywhere
		-- and must report nothing; the loop yields between 8 ms slices instead of stalling the frame.
		local tiles = {}
		local origin = Vector3.new(1000, GEO_Y + 200, 1000)
		for i = 0, 19 do
			for j = 0, 19 do
				table.insert(tiles, S.part({ Name = "GeoTile", Size = Vector3.new(4, 1, 4), CFrame = CFrame.new(origin + Vector3.new(i * 4, 0, j * 4)), Parent = folder }))
			end
		end
		for i = 0, 9 do
			for j = 0, 9 do
				table.insert(tiles, S.part({ Name = "GeoTileUpper", Size = Vector3.new(4, 1, 4), CFrame = CFrame.new(origin + Vector3.new(i * 4, 1, j * 4)), Parent = folder }))
			end
		end
		local list, info = geometry.overlaps(tiles)
		-- One tile pushed 0.25 studs into its neighbour is the only pair found afterwards.
		tiles[1].CFrame = tiles[1].CFrame + Vector3.new(0.25, 0, 0)
		local after, afterInfo = geometry.overlaps(tiles)
		local ok = #list == 0 and info.total == 0 and info.checked == 500 and info.sampled == false and #after == 1 and afterInfo.total == 1 and after[1].depth == 0.25
		return ok, ("clean=%d/%d ms=%s yields=%d; shifted=%d depth=%s"):format(info.total, info.checked, tostring(info.ms), info.yields, afterInfo.total, tostring(if after[1] then after[1].depth else nil))
	end)
	check("geometry.nested", function()
		-- A BasePart under a BasePart is the violation; an Attachment under a part is fine. A root
		-- Instance is accepted in place of the part list.
		local host = S.part({ Name = "GeoHost", Size = Vector3.new(2, 2, 2), CFrame = CFrame.new(0, GEO_Y + 20, 0), Parent = folder })
		local child = S.part({ Name = "GeoChild", Size = Vector3.new(1, 1, 1), CFrame = CFrame.new(0, GEO_Y + 30, 0), Parent = host })
		S.new("Attachment", { Name = "GeoAttachment" }, host)
		local list, total = geometry.nested({ host, child })
		local viaRoot = geometry.nested(folder :: Instance)
		local viaS = S.nested(folder)
		local ok = total == 1 and list[1] ~= nil and list[1].path == paths.of(child) and list[1].parent == paths.of(host) and list[1].class == "Part" and #viaRoot == 1 and #viaS == 1
		return ok, util.safeJsonEncode(list)
	end)
	check("S.placeOn", function()
		-- Bottom of the part's box on the top of the target's; X/Z kept, or centred; a Model target
		-- uses its bounding box; PlaceOn in a props table is the same after Size / CFrame are applied.
		local deck = S.part({ Name = "GeoDeck", Size = Vector3.new(10, 2, 10), CFrame = CFrame.new(100, GEO_Y, 0), Parent = folder })
		local crate = S.part({ Name = "GeoCrate", Size = Vector3.new(2, 4, 2), CFrame = CFrame.new(103, GEO_Y - 10, 1), Parent = folder })
		S.placeOn(crate, deck)
		local kept = crate.Position:FuzzyEq(Vector3.new(103, GEO_Y + 3, 1), 1e-3)
		S.placeOn(crate, deck, { align = "center", gap = 0.5 })
		local centred = crate.Position:FuzzyEq(Vector3.new(100, GEO_Y + 3.5, 0), 1e-3)
		local pillar = S.part({ Name = "GeoPillar", Size = Vector3.new(1, 6, 1), CFrame = CFrame.new(96, 0, -4), PlaceOn = deck, Parent = folder })
		local sugar = pillar.Position:FuzzyEq(Vector3.new(96, GEO_Y + 4, -4), 1e-3)
		local stack = S.model("GeoStack", {
			S.part({ Size = Vector3.new(2, 2, 2), CFrame = CFrame.new(120, GEO_Y, 0), Parent = folder }),
			S.part({ Size = Vector3.new(2, 2, 2), CFrame = CFrame.new(120, GEO_Y + 2, 0), Parent = folder }),
		}, folder)
		local lid = S.part({ Name = "GeoLid", Size = Vector3.new(4, 1, 4), CFrame = CFrame.new(120, 0, 0), Parent = folder })
		S.placeOn(lid, stack)
		local onModel = lid.Position:FuzzyEq(Vector3.new(120, GEO_Y + 3.5, 0), 1e-3)
		local okBad = pcall(S.placeOn, crate, folder)
		return kept and centred and sugar and onModel and not okBad, ("crate=%s pillar=%s lid=%s"):format(tostring(crate.Position), tostring(pillar.Position), tostring(lid.Position))
	end)
	check("S.fits", function()
		-- A pose clear of everything fits; one sunk into the slab names it; ignoring the slab, or
		-- merely touching its top, fits again; a part tests its own box and ignores itself.
		local slab = S.part({ Name = "GeoSlab", Size = Vector3.new(6, 1, 6), CFrame = CFrame.new(200, GEO_Y, 0), Parent = folder })
		local free, none = S.fits(CFrame.new(200, GEO_Y + 2, 0), Vector3.new(2, 2, 2))
		local clash, blockers = S.fits(CFrame.new(200, GEO_Y + 0.5, 0), Vector3.new(2, 2, 2))
		local ignored = S.fits(Vector3.new(200, GEO_Y + 0.5, 0), Vector3.new(2, 2, 2), { ignore = { slab } })
		local touching = S.fits(CFrame.new(200, GEO_Y + 1.5, 0), Vector3.new(2, 2, 2))
		local crate = S.part({ Name = "GeoFitCrate", Size = Vector3.new(2, 2, 2), CFrame = CFrame.new(200, GEO_Y + 1.5, 0), Parent = folder })
		local selfOk = S.fits(crate)
		S.set(crate, { CFrame = CFrame.new(200, GEO_Y + 0.5, 0) })
		local selfClash, selfBlockers = S.fits(crate)
		local ok = free and #none == 0 and not clash and blockers[1] == paths.of(slab) and ignored and touching and selfOk and not selfClash and selfBlockers[1] == paths.of(slab)
		return ok, ("free=%s clash=%s blockers=%s ignored=%s touching=%s self=%s/%s"):format(tostring(free), tostring(clash), table.concat(blockers, ","), tostring(ignored), tostring(touching), tostring(selfOk), tostring(selfClash))
	end)
	check("S.script.getRange", function()
		-- F6: {from, to} slices lines; the second value is always the total line count.
		local ms = S.script.create("ModuleScript", "Ranged", folder, "l1\nl2\nl3\nl4\nl5")
		local slice, total = S.script.get(ms, { from = 2, to = 3 })
		local tail, total2 = S.script.get(ms, { from = 4 })
		local whole, total3 = S.script.get(ms)
		return slice == "l2\nl3" and total == 5 and tail == "l4\nl5" and total2 == 5 and whole == "l1\nl2\nl3\nl4\nl5" and total3 == 5, ("%q %q"):format(slice, tail)
	end)
	check("observe.script", function()
		local ms = (folder :: Instance):FindFirstChild("Ranged")
		if ms == nil or env == nil then
			return false, if ms == nil then "no Ranged module" else "no env"
		end
		local r = observe.script({ path = paths.of(ms), from = 2, to = 3 }, env)
		local all = observe.script({ path = paths.of(ms) }, env)
		return r.text == "l2\nl3" and r.lines == 2 and r.total_lines == 5 and r.from == 2 and r.to == 3 and r.class == "ModuleScript" and all.lines == 5 and all.truncated == nil, util.safeJsonEncode(r)
	end)
	check("observe.scriptBudget", function()
		-- A source above the concise budget comes back as whole lines with a next_from cursor.
		if env == nil then
			return false, "no env"
		end
		local lines = table.create(2000)
		for i = 1, 2000 do
			lines[i] = ("line %04d %s"):format(i, string.rep("x", 20))
		end
		local ms = S.script.create("ModuleScript", "Big", folder, table.concat(lines, "\n"))
		local r = observe.script({ path = paths.of(ms) }, env)
		local encoded = util.safeJsonEncode(r)
		local lastLine = string.match(r.text, "[^\n]*$")
		return r.truncated == true and r.next_from == r.to + 1 and r.to < 2000 and r.lines == r.to and encoded ~= nil and #encoded <= protocol.CONCISE_BYTES and lastLine == lines[r.to], ("to=%d bytes=%d"):format(r.to, if encoded then #encoded else -1)
	end)
	check("run.escapes", function()
		-- F1: backslash escapes inside Luau strings reach the compiler untouched (the failures seen live
		-- came from shell heredocs, not from the bridge or this runtime).
		local body, err = runner.run({
			code = [[return #"a\nb" == 3 and ("x\ny"):find("[^\n]+") == 1 and #"\t" == 1 and #"\\n" == 2]],
			args = {},
			S = S,
			journal = nil,
			ephemeral = false,
		})
		if body == nil then
			return false, tostring(if type(err) == "table" then err.message else err)
		end
		return body.value == true, tostring(body.value)
	end)
	if journal then
		check("run.changesSameFrame", function()
			-- DescendantAdded is deferred: a part created in the program's last frame must still be counted.
			local body, err = runner.run({
				code = "S.part({ Name = 'sameFrame', Parent = ARGS.folder })",
				args = { folder = folder },
				S = S,
				journal = journal,
				ephemeral = false,
			})
			if body == nil then
				return false, tostring(if type(err) == "table" then err.message else err)
			end
			local changes = body.changes
			return changes.added >= 1, ("added=%d removed=%d paths=%s"):format(changes.added, changes.removed, table.concat(changes.paths, ","))
		end)
		check("run.changesRemoved", function()
			-- A detach inside a program counts as a removal with the instance's former path even though
			-- the DescendantRemoving handler runs after Parent is already nil (Deferred behaviour).
			local gone = Instance.new("Folder")
			gone.Name = "StudioLiveSelftestGone"
			gone.Parent = folder
			runner.flushDeferred() -- let its Added handler run before the program's mark
			local body, err = runner.run({
				code = "return S.destroy(ARGS.gone)",
				args = { gone = gone },
				S = S,
				journal = journal,
				ephemeral = false,
			})
			if body == nil then
				return false, tostring(if type(err) == "table" then err.message else err)
			end
			local changes = body.changes
			local expected = "Workspace." .. FOLDER_NAME .. ".StudioLiveSelftestGone"
			local listed = false
			for _, p in ipairs(changes.paths) do
				if p == expected then
					listed = true
				end
			end
			return body.value == 1 and changes.removed >= 1 and listed, ("added=%d removed=%d paths=%s"):format(changes.added, changes.removed, table.concat(changes.paths, ","))
		end)
		check("run.flushSubFrame", function()
			-- L3: the change flush must not cost a frame per run — six runs that each create an
			-- instance should complete within a couple of Heartbeats, every one counting its change.
			local counted = 0
			local flushes = {}
			local frames = framesDuring(function()
				for i = 1, 6 do
					local body = runner.run({
						code = "S.part({ Name = 'flush' .. ARGS.i, Parent = ARGS.folder })",
						args = { folder = folder, i = i },
						S = S,
						journal = journal,
						ephemeral = false,
						detailed = true,
					})
					if body and body.changes.added >= 1 then
						counted += 1
					end
					table.insert(flushes, if body then tostring(body.flush) else "error")
				end
			end)
			return counted == 6 and frames <= 2, ("counted=%d frames=%d flush=%s"):format(counted, frames, table.concat(flushes, ","))
		end)
		check("run.geometryWarn", function()
			-- Policy "warn": the body carries the report of the parts this run added (two blocks
			-- 2 studs into each other, one part under a part) and one warning line per list.
			local body, err = runner.run({
				code = [[
					local a = S.part({ Name = "GeoRunA", Size = Vector3.new(4, 4, 4), CFrame = CFrame.new(300, ARGS.y, 0), Parent = ARGS.folder })
					S.part({ Name = "GeoRunB", Size = Vector3.new(4, 4, 4), CFrame = CFrame.new(302, ARGS.y, 0), Parent = ARGS.folder })
					S.part({ Name = "GeoRunNested", Size = Vector3.new(1, 1, 1), CFrame = CFrame.new(300, ARGS.y + 100, 0), Parent = a })
					return true
				]],
				args = { folder = folder, y = GEO_Y },
				S = S,
				journal = journal,
				ephemeral = false,
				geometryPolicy = "warn",
			})
			if body == nil then
				return false, tostring(if type(err) == "table" then err.message else err)
			end
			local g = body.geometry
			if type(g) ~= "table" then
				return false, "no geometry in the body: " .. tostring(util.safeJsonEncode(body.warnings))
			end
			local warnings = table.concat(body.warnings or {}, " | ")
			local pair = g.overlaps[1]
			local ok = g.totals.overlaps == 1 and g.totals.nested == 1 and pair ~= nil and pair.depth == 2 and g.nested[1] ~= nil and g.nested[1].path == "Workspace." .. FOLDER_NAME .. ".GeoRunA.GeoRunNested" and g.checked == 3 and g.sampled == nil and string.find(warnings, "overlapping part pair", 1, true) ~= nil and string.find(warnings, "parented under another part", 1, true) ~= nil
			return ok, util.safeJsonEncode(g) .. " " .. warnings
		end)
		check("run.geometryReject", function()
			-- Policy "reject": the run fails with geometry_violation carrying the same report (the hub
			-- then cancels the recording like any error); "off" / absent never adds `geometry`.
			local code = "S.part({ Name = 'GeoRejA', Size = Vector3.new(2, 2, 2), CFrame = CFrame.new(400, ARGS.y, 0), Parent = ARGS.folder }); S.part({ Name = 'GeoRejB', Size = Vector3.new(2, 2, 2), CFrame = CFrame.new(401, ARGS.y, 0), Parent = ARGS.folder })"
			local body, err = runner.run({ code = code, args = { folder = folder, y = GEO_Y }, S = S, journal = journal, ephemeral = false, geometryPolicy = "reject" })
			local e = if type(err) == "table" then err else {}
			local rejected = body == nil and e.code == "geometry_violation" and type(e.geometry) == "table" and e.geometry.totals.overlaps == 1 and type(e.output) == "table" and string.find(tostring(e.message), "overlapping", 1, true) ~= nil
			local off, offErr = runner.run({ code = code, args = { folder = folder, y = GEO_Y }, S = S, journal = journal, ephemeral = false, geometryPolicy = "off" })
			-- (S.unwritable still holds the entries of earlier checks, so `warnings` may carry that line.)
			local silent = off ~= nil and off.geometry == nil and string.find(table.concat(off.warnings or {}, " "), "overlapping", 1, true) == nil
			local none, noneErr = runner.run({ code = code, args = { folder = folder, y = GEO_Y }, S = S, journal = journal, ephemeral = false })
			local absent = none ~= nil and none.geometry == nil
			return rejected and silent and absent, ("reject=%s code=%s off=%s absent=%s"):format(tostring(rejected), tostring(e.code), tostring(if off then "ok" else offErr), tostring(if none then "ok" else noneErr))
		end)
		check("run.geometryMoved", function()
			-- A pre-existing part the program pushes into another through S.set is checked like an added
			-- one (S.touched); a second run that rests it on the slab with S.placeOn reports nothing.
			local slab = S.part({ Name = "GeoMoveSlab", Size = Vector3.new(6, 1, 6), CFrame = CFrame.new(500, GEO_Y, 0), Parent = folder })
			local mover = S.part({ Name = "GeoMover", Size = Vector3.new(2, 2, 2), CFrame = CFrame.new(500, GEO_Y + 10, 0), Parent = folder })
			runner.flushDeferred() -- their Added handlers must run before the program's mark
			local body, err = runner.run({
				code = "S.set(ARGS.mover, { CFrame = CFrame.new(500, ARGS.y + 0.5, 0) }); return true",
				args = { mover = mover, y = GEO_Y },
				S = S,
				journal = journal,
				ephemeral = false,
				geometryPolicy = "warn",
			})
			if body == nil then
				return false, tostring(if type(err) == "table" then err.message else err)
			end
			local g = body.geometry
			local moved = type(g) == "table" and g.totals.overlaps == 1 and g.checked == 1 and g.overlaps[1] ~= nil and g.overlaps[1].a == paths.of(mover) and g.overlaps[1].b == paths.of(slab) and g.overlaps[1].depth == 1
			local fixed, err2 = runner.run({
				code = "S.placeOn(ARGS.mover, ARGS.slab); return true",
				args = { mover = mover, slab = slab },
				S = S,
				journal = journal,
				ephemeral = false,
				geometryPolicy = "warn",
			})
			local clean = fixed ~= nil and fixed.geometry == nil and mover.Position:FuzzyEq(Vector3.new(500, GEO_Y + 1.5, 0), 1e-3)
			return moved and clean, ("moved=%s %s; clean=%s %s"):format(tostring(moved), tostring(util.safeJsonEncode(g)), tostring(clean), tostring(if fixed then mover.Position else err2))
		end)
	end
	check("observe.geometry", function()
		-- The whole-subtree audit: overlaps and nesting under an explicit root, totals and counters.
		local r = observe.geometry({ root = "Workspace." .. FOLDER_NAME })
		local okRoot = r.root == "Workspace." .. FOLDER_NAME and type(r.parts) == "number" and r.parts >= 4 and r.checked == r.parts and r.sampled == false and type(r.ms) == "number"
		local okLists = r.totals.overlaps >= 2 and #r.overlaps == r.totals.overlaps and r.totals.nested >= 1 and #r.nested == r.totals.nested
		local none = observe.geometry({ root = "Workspace." .. FOLDER_NAME, include_nested = false })
		local okBad = pcall(observe.geometry, { root = "Workspace.StudioLiveNoSuchRoot" })
		return okRoot and okLists and #none.nested == 0 and none.totals.nested == 0 and not okBad, ("parts=%s checked=%s overlaps=%s nested=%s"):format(tostring(r.parts), tostring(r.checked), tostring(r.totals.overlaps), tostring(r.totals.nested))
	end)
	check("S.destroy", function()
		-- Edit DM: detached (Parent = nil), referenced in S.detached, gone from the tree.
		local before = #S.detached
		local n = S.destroy(folder) + S.destroy(pre)
		return n == 2 and Workspace:FindFirstChild(FOLDER_NAME) == nil and Workspace:FindFirstChild(PRE_FOLDER_NAME) == nil and pre.Parent == nil and #S.detached == before + 2, ("detached=%d"):format(#S.detached)
	end)
	if recording then
		pcall(ChangeHistoryService.FinishRecording, ChangeHistoryService, recording, Enum.FinishRecordingOperation.Cancel)
		-- Cancel re-parents restored instances on the next frame; read the tree after it has run.
		task.wait()
	end
	check("undo.cleanup", function()
		local leftover = Workspace:FindFirstChild(FOLDER_NAME)
		if leftover then
			leftover:Destroy()
			return false, "folder survived the cancelled recording"
		end
		return true
	end)
	check("S.destroy.restoreOnCancel", function()
		-- F2: Cancel re-parents what S.destroy detached (a Destroy()ed instance could not come back).
		if recording == nil then
			pre:Destroy()
			return true, "skipped: no recording"
		end
		local restored = pre.Parent == Workspace and Workspace:FindFirstChild(PRE_FOLDER_NAME) == pre
		pre:Destroy()
		return restored, if restored then nil else "the detached folder was not restored by Cancel"
	end)
	return checks
end

-- `journal` (the hub's change journal) enables the run/changes checks; without it those are skipped.
-- `extras.env` enables the observe.script checks.
function selftest.run(makeS: () -> any, journal: any?, extras: Extras?): { [string]: any }
	local checks = runChecks(makeS, journal, extras)
	local ok = true
	for _, c in ipairs(checks) do
		if not c.ok then
			ok = false
		end
	end
	return { ok = ok, checks = checks, loadstring = runner.hasLoadstring }
end

return selftest
