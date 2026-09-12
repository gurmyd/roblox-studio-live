--[[
	Agent runtime for play DMs (server / client), linked to the hub over the
	bootstrap's PluginConnection-backed Link. Same dispatcher shape as the hub.
]]

local shared = script.Parent.Parent.shared
local Dispatcher = require(shared.dispatcher)
local Fps = require(shared.fps)
local geometry = require(shared.geometry)
local Journal = require(shared.journal)
local Logs = require(shared.logs)
local observe = require(shared.observe)
local paths = require(shared.paths)
local protocol = require(shared.protocol)
local runner = require(shared.runner)
local S = require(shared.S)
local types = require(shared.types)
local util = require(shared.util)

local Controllers = require(script.Parent.controllers)
local Events = require(script.Parent.events)
local hotpatch = require(script.Parent.hotpatch)
local Input = require(script.Parent.input)
local runUntil = require(script.Parent.run_until)

type Ctx = types.Ctx
type Runtime = types.Runtime
type Request = types.Request
type Control = types.Control

local agent = {}

function agent.start(ctx: Ctx): Runtime
	local dm = if type(ctx.dm) == "string" and ctx.dm ~= "" then ctx.dm else ctx.role
	local link = ctx.link
	local warnLimited = util.rateLimitedWarn(5)
	local running = true

	local logs = Logs.new(dm)
	-- A replacement runtime (bundle swap mid-test) resumes the previous aseq so cursors stay monotonic.
	local previousSeq = if type(ctx.lastSeq) == "number" then ctx.lastSeq else 0
	local events = Events.new(link, dm, logs, previousSeq)
	local journal = Journal.new()
	local fps = Fps.new()

	local env: types.Env = {
		role = ctx.role,
		dm = dm,
		session = ctx.session or "",
		emit = events.emit,
		journal = journal,
		logs = logs,
		fps = function()
			return fps:value()
		end,
		hasLoadstring = runner.hasLoadstring,
	}

	local function makeS(ctl: Control?)
		return S.new({ role = ctx.role, dm = dm, emit = events.emit }, ctl)
	end

	local input = Input.new(ctx.role)
	local controllers = Controllers.new(env, function()
		return makeS(nil)
	end, input)

	local function sendText(text: string)
		if not link.send(text) then
			warnLimited("send failed (link closed)")
		end
	end

	-- A response that cannot be encoded is replaced by an `internal` error so the request still ends.
	local function sendFrame(frame: { [string]: any })
		local text = util.safeJsonEncode(frame)
		if text ~= nil then
			sendText(text)
			return
		end
		warnLimited("could not encode frame kind=" .. tostring(frame.kind))
		if frame.kind == "res" then
			local fallback = util.safeJsonEncode(protocol.err(tostring(frame.id), dm, { code = "internal", message = "response not encodable (invalid UTF-8 or unsupported value)" }))
			if fallback then
				sendText(fallback)
			end
		end
	end

	local dispatcher = Dispatcher.new(dm, sendFrame, events.emit)

	-- run (§4.1): ephemeral, no undo in play DMs.
	dispatcher:register("run", function(req: Request, ctl: Control)
		local body = req.body
		if type(body.code) ~= "string" then
			error(util.perr("bad_request", "run: 'code' must be a string"), 0)
		end
		-- Play-DM parts are ephemeral: the geometry check (§4.1) runs only when the request asks for it.
		local geometryPolicy, policyErr = geometry.policy(body.geometry_policy, nil)
		if policyErr then
			error(util.perr("bad_request", "run: " .. policyErr), 0)
		end
		local result, err = runner.run({
			code = body.code,
			args = body.args,
			S = makeS(ctl),
			ctl = ctl,
			journal = journal,
			ephemeral = true,
			detailed = body.response_format == "detailed" or body.format == "detailed",
			geometryPolicy = geometryPolicy,
		})
		if err then
			if type(err) == "table" and err.code == "geometry_violation" then
				-- Nothing here is undoable: the parts stay until the playtest ends.
				err.undo = "n/a"
				err.message = tostring(err.message) .. " (play DM: the parts are ephemeral and were not removed)"
			end
			error(err, 0)
		end
		local out = result :: { [string]: any }
		out.undo = "n/a"
		return out
	end)

	local function status(): { [string]: any }
		return {
			session = ctx.session,
			bootstrap = ctx.bootstrapVersion,
			bundleHash = ctx.bundleHash,
			role = ctx.role,
			dm = dm,
			place = { placeId = game.PlaceId, placeName = game.Name },
			peers = {},
			playtest = { running = true },
			capabilities = { loadstring = runner.hasLoadstring, virtualInput = input:available(), capture = false },
			fps = util.round(fps:value(), 1),
			instanceCount = #game:GetDescendants(),
			journal = { seq = events.lastSeq(), dropped = 0 },
		}
	end

	dispatcher:register("observe", function(req: Request)
		return observe.handle(req.body, env, {
			status = status,
			selection = function()
				error(util.perr("unsupported", "selection is edit-DM only"), 0)
			end,
		})
	end)

	dispatcher:register("playtest", function(req: Request, ctl: Control)
		local body = req.body
		local action = body.action
		if action == "run_until" then
			return runUntil.run(body, ctl, makeS(ctl))
		elseif action == "install" then
			return controllers:install(body, ctl)
		elseif action == "uninstall" then
			return controllers:uninstall(body)
		elseif action == "list" then
			return { controllers = controllers:list() }
		elseif action == "hotpatch" then
			return hotpatch.apply(body)
		end
		error(util.perr("unsupported", ("playtest action '%s' is handled by the hub, not a play DM"):format(tostring(action))), 0)
	end)

	dispatcher:register("input", function(req: Request, ctl: Control)
		return input:run(req.body, ctl)
	end)

	-- StudioTestService is resolved per call, not at load time, so a client DM where it is
	-- unavailable still runs the rest of the agent.
	local function studioTestService(op: string): any
		if ctx.role ~= "server" then
			error(util.perr("unsupported", ("%s must be sent to the server DM"):format(op)), 0)
		end
		local okSvc, sts = pcall(game.GetService, game, "StudioTestService")
		if not okSvc or sts == nil then
			error(util.perr("unsupported", ("StudioTestService is unavailable in this DM: %s"):format(tostring(sts))), 0)
		end
		return sts
	end

	-- endtest (§4.5): only the server DM may end the test.
	dispatcher:register("endtest", function()
		local sts = studioTestService("endtest")
		local ok, err = pcall(sts.EndTest, sts, "studio-live")
		if not ok then
			error(util.perr("internal", ("EndTest failed: %s"):format(tostring(err))), 0)
		end
		return { ending = true }
	end)

	-- addplayers (hub `playtest add_players`): spawns more client processes in a multiplayer test.
	dispatcher:register("addplayers", function(req: Request)
		local count = math.floor(util.num(req.body.count, 1, 1, 8))
		local sts = studioTestService("addplayers")
		local ok, err = pcall(sts.AddPlayers, sts, count)
		if not ok then
			error(util.perr("internal", ("AddPlayers(%d) failed: %s"):format(count, tostring(err))), 0)
		end
		return { added = count }
	end)

	-- push_apply (hub `push`): base64 → SerializationService buffer → instances parented in this DM.
	-- `parents[i]` / `names[i]` describe the i-th serialized root; `parent` overrides them all.
	-- `replace` (default true): a same-named child already under the target parent is detached
	-- (Parent = nil, so a failed push can put it back) before the new root is parented, and
	-- destroyed once every root is in place; the response counts them as `replaced`.
	dispatcher:register("push_apply", function(req: Request)
		local body = req.body
		if type(body.b64) ~= "string" or body.b64 == "" then
			error(util.perr("bad_request", "push_apply: 'b64' must be a non-empty string"), 0)
		end
		local okS, Serialization = pcall(game.GetService, game, "SerializationService")
		local okE, Encoding = pcall(game.GetService, game, "EncodingService")
		if not okS or not okE or Serialization == nil or Encoding == nil then
			error(util.perr("unsupported", "SerializationService / EncodingService are unavailable in this DM"), 0)
		end
		local t0 = os.clock()
		local okD, buf = pcall((Encoding :: any).Base64Decode, Encoding, buffer.fromstring(body.b64))
		if not okD or typeof(buf) ~= "buffer" then
			error(util.perr("bad_request", ("push_apply: base64 decode failed: %s"):format(tostring(buf))), 0)
		end
		local okI, list = pcall((Serialization :: any).DeserializeInstancesAsync, Serialization, buf)
		if not okI or type(list) ~= "table" then
			error(util.perr("internal", ("DeserializeInstancesAsync failed: %s"):format(tostring(list))), 0)
		end
		local names: { any } = if type(body.names) == "table" then body.names else {}
		local parents: { any } = if type(body.parents) == "table" then body.parents else {}
		-- The hub tags roots with their index when names collide (position and name are then ambiguous);
		-- the attribute is stripped here so nothing of the trip stays on the instance.
		local indexAttribute: string? = if type(body.index_attribute) == "string" and body.index_attribute ~= "" then body.index_attribute else nil
		local function parentPathFor(i: number, inst: Instance): string?
			if type(body.parent) == "string" then
				return body.parent
			end
			if indexAttribute then
				local okA, idx = pcall(inst.GetAttribute, inst, indexAttribute)
				if okA and type(idx) == "number" and type(parents[idx]) == "string" then
					return parents[idx]
				end
			end
			if names[i] == inst.Name and type(parents[i]) == "string" then
				return parents[i]
			end
			-- Roots came back in another order (or renamed): match by name, else fall back to position.
			for j, n in ipairs(names) do
				if n == inst.Name and type(parents[j]) == "string" then
					return parents[j]
				end
			end
			return if type(parents[i]) == "string" then parents[i] else nil
		end
		local replace = body.replace ~= false
		local pushed: { [Instance]: boolean } = {}
		for _, inst in ipairs(list :: { Instance }) do
			pushed[inst] = true
		end
		local placed: { Instance } = {}
		local outPaths: { string } = {}
		local removed: { { inst: Instance, parent: Instance } } = {}
		-- Siblings `replace` must never take: the engine's and the players' own instances (a multiplayer
		-- client's character is literally named Player1, the camera Camera, the terrain Terrain).
		local skipped: { { path: string, reason: string } } = {}
		local okPlayers, PlayersService = pcall(game.GetService, game, "Players")
		local function protectedSibling(sibling: Instance): string?
			if sibling:IsA("Terrain") then
				return "Terrain"
			end
			if sibling:IsA("Camera") and sibling.Parent == workspace and workspace.CurrentCamera == sibling then
				return "CurrentCamera"
			end
			if okPlayers and PlayersService ~= nil then
				local okChar, player = pcall((PlayersService :: any).GetPlayerFromCharacter, PlayersService, sibling)
				if okChar and player ~= nil then
					return "player character"
				end
			end
			return nil
		end
		local function rollback()
			for _, inst in ipairs(placed) do
				pcall(inst.Destroy, inst)
			end
			for _, inst in ipairs(list :: { Instance }) do
				pcall(inst.Destroy, inst)
			end
			-- Detached siblings go back where they were.
			for _, r in ipairs(removed) do
				pcall(function()
					r.inst.Parent = r.parent
				end)
			end
		end
		for i, inst in ipairs(list :: { Instance }) do
			local parentPath = parentPathFor(i, inst)
			if indexAttribute then
				pcall(inst.SetAttribute, inst, indexAttribute, nil)
			end
			local parent = if parentPath then paths.resolve(parentPath) else nil
			if parent == nil then
				rollback()
				error(util.perr("bad_request", ("push_apply: no instance at parent path '%s' in %s"):format(tostring(parentPath), dm)), 0)
			end
			if replace then
				-- A replaceable sibling has the same Name AND ClassName as the pushed root (a Folder never
				-- replaces a Script of the same name) and is nothing the engine or a player owns.
				for _, sibling in ipairs(parent:GetChildren()) do
					if sibling.Name == inst.Name and not pushed[sibling] then
						local why = if sibling.ClassName ~= inst.ClassName then ("class %s ≠ %s"):format(sibling.ClassName, inst.ClassName) else protectedSibling(sibling)
						if why ~= nil then
							table.insert(skipped, { path = paths.of(sibling), reason = why })
						else
							local okR = pcall(function()
								sibling.Parent = nil
							end)
							if okR then
								table.insert(removed, { inst = sibling, parent = parent })
							else
								table.insert(skipped, { path = paths.of(sibling), reason = "locked" })
							end
						end
					end
				end
			end
			local okP, errP = pcall(function()
				inst.Parent = parent
			end)
			if not okP then
				rollback()
				error(util.perr("internal", ("push_apply: could not parent '%s' under '%s': %s"):format(inst.Name, tostring(parentPath), tostring(errP))), 0)
			end
			table.insert(placed, inst)
			table.insert(outPaths, paths.of(inst))
		end
		for _, r in ipairs(removed) do
			pcall(r.inst.Destroy, r.inst)
		end
		return {
			paths = outPaths,
			count = #placed,
			bytes = buffer.len(buf),
			apply_ms = util.round((os.clock() - t0) * 1000, 1),
			replaced = #removed,
			skipped = if #skipped > 0 then skipped else nil,
		}
	end)

	local offFrame = link.onFrame(function(text: string, decoded: { [string]: any }?)
		if not running then
			return
		end
		local frame = decoded or util.safeJsonDecode(text)
		if frame == nil then
			warnLimited("dropped undecodable frame from hub")
			return
		end
		local ok, err = pcall(dispatcher.handle, dispatcher, frame)
		if not ok then
			warnLimited("frame handling failed: " .. tostring(err))
		end
	end)

	-- Startup output (F4): game scripts print before this runtime exists, so the history of this DM
	-- (lines since the test started, by `time()`) is emitted as `log` events with `history = true` —
	-- the hub stamps real seqs, so `observe logs since=N` pages them like live lines. A replacement
	-- runtime (previousSeq > 0) already had its predecessor capture them live and seeds locally only.
	local seeded = 0
	if previousSeq > 0 then
		seeded = logs:seedHistory(200)
	else
		local okT, elapsed = pcall(time)
		local sinceWall = os.time() - (if okT and type(elapsed) == "number" then math.floor(elapsed) else 0) - 1
		seeded = logs:seedHistory(200, { sinceWall = sinceWall, emit = events.emit })
	end
	logs:attach(events.emit)
	journal:start(events.emit)

	events.emit({ type = "log", level = "info", msg = ("agent runtime started (%s, bundle %s)%s"):format(dm, string.sub(ctx.bundleHash, 1, 16), if seeded > 0 then (", %d history line%s"):format(seeded, if seeded == 1 then "" else "s") else "") })

	local runtime: Runtime = {
		stop = function()
			if not running then
				return
			end
			running = false
			dispatcher:failAll("disconnected", "agent runtime stopping")
			dispatcher:stop()
			controllers:unloadAll()
			input:releaseAll()
			offFrame()
			logs:detach()
			journal:stop()
			fps:stop()
		end,
		relinked = function()
			-- PluginConnections cannot reconnect (§1.2); nothing to resend.
		end,
		lastSeq = events.lastSeq,
	}
	return runtime
end

return agent
