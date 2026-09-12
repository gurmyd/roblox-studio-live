--[[
	Hub runtime for the edit DM: owns the bridge link, request routing (local ops vs.
	forwarding to play-DM agents with the same id), the event journal, the
	PluginConnection star, playtest control and heartbeats.
]]

local MarketplaceService = game:GetService("MarketplaceService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local Selection = game:GetService("Selection")

local shared = script.Parent.Parent.shared
local Dispatcher = require(shared.dispatcher)
local Fps = require(shared.fps)
local Journal = require(shared.journal)
local Logs = require(shared.logs)
local observe = require(shared.observe)
local paths = require(shared.paths)
local protocol = require(shared.protocol)
local runner = require(shared.runner)
local S = require(shared.S)
local types = require(shared.types)
local util = require(shared.util)

local Events = require(script.Parent.events)
local Link = require(script.Parent.link)
local Persist = require(script.Parent.persist)
local Playtest = require(script.Parent.playtest)
local Push = require(script.Parent.push)
local Run = require(script.Parent.run)
local selftest = require(script.Parent.selftest)
local Star = require(script.Parent.star)

type Ctx = types.Ctx
type Runtime = types.Runtime
type Request = types.Request
type Control = types.Control

local hub = {}

local FORWARD_GRACE_S = 5
local SELECTION_THROTTLE_S = 0.25
-- A GetProductInfo answer arriving later than this is ignored (game.Name stays the fallback).
local PLACE_NAME_TIMEOUT_S = 15

type Forwarded = { dm: string, op: string, body: { [string]: any }, timer: thread? }

-- Which DM executes a request (§2.1, §4 and protocol Notes): body.dm, then a non-edit
-- req.dm, then the op's default for playtest/input/player; req.dm for everything else.
local function routeTarget(frame: { [string]: any }): string
	local op = frame.op
	local body = if type(frame.body) == "table" then frame.body else {}
	local reqDm = if type(frame.dm) == "string" then frame.dm else "edit"
	local function peerDm(default: string): string
		if type(body.dm) == "string" then
			return body.dm
		elseif reqDm ~= "edit" then
			return reqDm
		end
		return default
	end
	if op == "playtest" then
		local action = body.action
		if action == "run_until" or action == "install" or action == "uninstall" or action == "hotpatch" then
			return peerDm("server")
		end
		return "edit"
	elseif op == "push" or op == "persist_sync" then
		-- push: serialised on the hub; body.dm names the play DM that receives `push_apply`.
		-- persist_sync: the bridge's persisted-controller list for this hub.
		return "edit"
	elseif op == "input" then
		return peerDm("client")
	elseif op == "observe" then
		if body.what == "player" then
			return peerDm("client")
		elseif body.what == "logs" or body.what == "status" or body.what == "selection" then
			return "edit"
		end
	end
	return reqDm
end

function hub.start(ctx: Ctx): Runtime
	local link = Link.new(ctx.link)
	local warnLimited = util.rateLimitedWarn(5)
	local running = true
	local session = ctx.session or ""
	local bridgeId = ctx.bridgeId

	local logs = Logs.new("edit")
	local events = Events.new(link, ctx.lastSeq or 0, ctx.ackUpto or 0, logs)
	local journal = Journal.new()
	local fps = Fps.new()

	local function scriptEditor(script: LuaSourceContainer, source: string): (boolean, string?)
		local ok, err = pcall(function()
			ScriptEditorService:UpdateSourceAsync(script, function()
				return source
			end)
		end)
		return ok, if ok then nil else tostring(err)
	end

	-- The text the human sees in an open editor tab, which may be ahead of the saved Source.
	local function scriptSource(script: LuaSourceContainer): string?
		local ok, text = pcall(ScriptEditorService.GetEditorSource, ScriptEditorService, script)
		return if ok and type(text) == "string" then text else nil
	end

	local env: types.Env = {
		role = "edit",
		dm = "edit",
		session = session,
		emit = events.emit,
		journal = journal,
		logs = logs,
		fps = function()
			return fps:value()
		end,
		hasLoadstring = runner.hasLoadstring,
		scriptSource = scriptSource,
	}

	local function makeS(ctl: Control?)
		return S.new({ role = "edit", dm = "edit", emit = events.emit, scriptEditor = scriptEditor, scriptSource = scriptSource }, ctl)
	end

	-- Responses / progress go through the queue so a socket refresh does not lose them (§ Notes);
	-- a response that cannot be encoded is replaced by an `internal` error so the job still ends.
	local function respond(frame: { [string]: any })
		if link.sendOrQueue(frame) then
			return
		end
		if frame.kind == "res" then
			link.sendOrQueue(protocol.err(tostring(frame.id), tostring(frame.dm or "edit"), { code = "internal", message = "response not encodable (invalid UTF-8 or unsupported value)" }))
		end
	end

	-- Internal hub → agent requests ("h-<n>" ids): responses are consumed here, not relayed.
	local internalSeq = 0
	local pendingInternal: { [string]: { thread: thread, dm: string } } = {}
	-- Bridge requests forwarded to agents (same id): tracked for disconnect / deadline.
	local forwarded: { [string]: Forwarded } = {}

	local star: Star.Star
	local playtest: Playtest.Playtest
	-- The real place name once MarketplaceService answered; game.Name ("Place1") until then.
	local placeName: string? = nil

	-- Universe / creator identity (readable in the edit DM; the bootstrap hello cannot carry it).
	local function placeIds(): { [string]: any }
		local okU, universeId = pcall(function()
			return game.GameId
		end)
		local okC, creatorType = pcall(function()
			return game.CreatorType.Name
		end)
		local okI, creatorId = pcall(function()
			return game.CreatorId
		end)
		return {
			universeId = if okU and type(universeId) == "number" then universeId else nil,
			creatorType = if okC and type(creatorType) == "string" then creatorType else nil,
			creatorId = if okI and type(creatorId) == "number" then creatorId else nil,
		}
	end

	local function heartbeat()
		events.hb(star:list(), playtest:info(), fps:value(), placeName, placeIds())
	end

	local function request(dm: string, op: string, body: { [string]: any }, timeoutS: number): (boolean, any)
		local peer = star:get(dm)
		if peer == nil then
			return false, util.perr("no_peer", ("no connected peer '%s'"):format(dm))
		end
		internalSeq += 1
		local id = ("h-%d"):format(internalSeq)
		local thread = coroutine.running()
		pendingInternal[id] = { thread = thread, dm = peer.dm :: string }
		local frame = { v = protocol.VERSION, kind = "req", id = id, op = op, dm = peer.dm, deadline_ms = math.floor(timeoutS * 1000), body = body }
		if not star:send(peer, frame) then
			pendingInternal[id] = nil
			return false, util.perr("disconnected", ("could not send to '%s'"):format(dm))
		end
		task.delay(timeoutS + 1, function()
			if pendingInternal[id] then
				pendingInternal[id] = nil
				pcall(task.spawn, thread, nil)
			end
		end)
		local res = coroutine.yield()
		if type(res) ~= "table" then
			return false, util.perr("timeout", ("no answer from '%s' within %d s"):format(dm, timeoutS))
		end
		if res.ok then
			return true, res.body
		end
		return false, res.error or util.perr("internal", "agent error")
	end

	local function dropForwarded(id: string): Forwarded?
		local entry = forwarded[id]
		if entry == nil then
			return nil
		end
		forwarded[id] = nil
		if entry.timer then
			pcall(task.cancel, entry.timer)
		end
		return entry
	end

	local function failPending(dm: string, code: string, message: string)
		for id, entry in pairs(pendingInternal) do
			if entry.dm == dm then
				pendingInternal[id] = nil
				pcall(task.spawn, entry.thread, { ok = false, error = util.perr(code, message) })
			end
		end
		for id, entry in pairs(forwarded) do
			if entry.dm == dm then
				dropForwarded(id)
				respond(protocol.err(id, dm, { code = code, message = message }))
			end
		end
	end

	star = Star.new(session, ctx.bundle, {
		onEvent = function(peer, frame)
			frame.src = frame.src or peer.dm
			-- Startup history (F4) a Play-Solo *client* re-sends for server output already journaled
			-- here — LogService mirrors server prints into that client's history — is dropped, not
			-- stamped. Only client lines are checked and only against server lines, so a server's own
			-- repeats survive, a client's own output is kept, and multiplayer test players (separate
			-- processes, userId ≤ 0, nothing mirrored) are never deduped.
			if frame.type == "log" and frame.history == true and peer.dm ~= "server" and not (type(peer.userId) == "number" and peer.userId <= 0) and logs:hasSimilar(frame, nil, "server") then
				return
			end
			events.emit(frame)
		end,
		onResponse = function(peer, frame)
			local id = frame.id
			if type(id) ~= "string" then
				return
			end
			local internal = pendingInternal[id]
			if internal then
				if frame.kind == "res" then
					pendingInternal[id] = nil
					pcall(task.spawn, internal.thread, frame)
				end
				return
			end
			if frame.kind == "res" then
				local fwd = dropForwarded(id)
				if fwd == nil then
					return -- already answered (deadline) or unknown; drop
				end
				frame.dm = frame.dm or peer.dm
				if frame.ok == true and fwd.op == "playtest" and type(fwd.body.name) == "string" then
					if fwd.body.action == "install" and fwd.body.persist == true and type(fwd.body.code) == "string" then
						-- The bridge stores the durable copy; the hub mirrors it so the next peer hello
						-- re-installs it even before the bridge's next persist_sync.
						playtest:remember(fwd.dm, fwd.body.name, fwd.body.code)
						if type(frame.body) == "table" then
							frame.body.persist_source = "bridge"
						end
					elseif fwd.body.action == "install" or fwd.body.action == "uninstall" then
						-- The latest install decides: a non-persisted replacement must not be undone by a
						-- stale durable entry on the next hello.
						playtest:forget(fwd.dm, fwd.body.name)
					end
				end
			elseif forwarded[id] == nil then
				return -- progress for a request that is no longer tracked
			end
			respond(frame)
		end,
		onPeer = function(peer, connected)
			events.emit({ type = "peer", dm = peer.dm, connected = connected, userId = peer.userId, playerName = peer.playerName })
			if connected then
				playtest:onPeerConnected(peer.dm :: string)
			else
				failPending(peer.dm :: string, "disconnected", ("peer %s disconnected"):format(peer.dm :: string))
				playtest:onPeerDisconnected(peer.dm :: string)
			end
			heartbeat()
		end,
		onIdentity = function(peer)
			events.emit({ type = "peer", dm = peer.dm, connected = true, userId = peer.userId, playerName = peer.playerName })
			heartbeat()
		end,
	})
	-- Persisted controllers: the bridge holds the durable list (plugin settings cannot be read in
	-- this Studio build) and replaces the hub's copy with `persist_sync` on every connect, so a hub
	-- runtime restart (bundle update) gets the list back before the agents say hello again.
	local persist = Persist.new(warnLimited)
	playtest = Playtest.new(star, events.emit, request, persist)
	playtest.onChange = heartbeat

	local dispatcher = Dispatcher.new("edit", respond, events.emit)

	dispatcher:register("run", Run.handler({ journal = journal, makeS = makeS }), true)

	dispatcher:register("selftest", function()
		return selftest.run(function()
			return makeS(nil)
		end, journal, { env = env })
	end, true)

	dispatcher:register("push", Push.handler({ star = star, request = request }))

	-- persist_sync (bridge → hub, on every hub connect): {controllers: [{dm, name, code}]} replaces the
	-- persisted list; connected peers receive what they are missing. Also accepted as a bare frame.
	local function applyPersistSync(list: any): { [string]: any }
		if type(list) ~= "table" then
			error(util.perr("bad_request", "persist_sync: 'controllers' must be an array"), 0)
		end
		local accepted, rejected, issued = playtest:onPersistSync(list)
		return { persisted = accepted, rejected = rejected, installs_issued = issued }
	end
	dispatcher:register("persist_sync", function(req: Request)
		return applyPersistSync(req.body.controllers)
	end)

	local function status(): { [string]: any }
		local place: { [string]: any } = { placeId = game.PlaceId, placeName = placeName or game.Name, dataModelName = game.Name }
		for k, v in pairs(placeIds()) do
			place[k] = v
		end
		return {
			session = session,
			bootstrap = ctx.bootstrapVersion,
			bundleHash = ctx.bundleHash,
			role = "edit",
			place = place,
			peers = star:list(),
			playtest = playtest:info(),
			capabilities = { loadstring = runner.hasLoadstring, virtualInput = false, capture = false, pluginConnection = star:available() },
			fps = util.round(fps:value(), 1),
			instanceCount = #game:GetDescendants(),
			journal = { seq = events.lastSeq(), dropped = events.dropped(), unacked = events.unacked() },
			writeQueue = { active = dispatcher.activeWrite, waiting = dispatcher:queued() },
			persisted = persist:count(),
			link = link.stats(),
		}
	end

	local function selectionPaths(): { string }
		local out = {}
		for i, inst in ipairs(Selection:Get()) do
			if i > 100 then
				break
			end
			table.insert(out, paths.of(inst))
		end
		return out
	end

	dispatcher:register("observe", function(req: Request)
		return observe.handle(req.body, env, {
			status = status,
			selection = function()
				return { paths = selectionPaths() }
			end,
		})
	end)

	dispatcher:register("playtest", function(req: Request, ctl: Control)
		local action = req.body.action
		if action == "start" then
			return playtest:doStart(req.body, ctl)
		elseif action == "stop" then
			return playtest:doStop(ctl)
		elseif action == "status" then
			return playtest:doStatus()
		elseif action == "list" then
			return { controllers = playtest:listControllers(), persisted = persist:list() }
		elseif action == "add_players" then
			return playtest:doAddPlayers(req.body, ctl)
		end
		error(util.perr("bad_request", ("playtest: unknown action '%s'"):format(tostring(action))), 0)
	end)

	local function forward(frame: { [string]: any }, text: string, target: string)
		local id = frame.id
		if type(id) ~= "string" then
			respond(protocol.err("?", "edit", { code = "bad_request", message = "req.id must be a string" }))
			return
		end
		if forwarded[id] ~= nil or dispatcher.inflight[id] ~= nil then
			respond(protocol.err(id, "edit", { code = "bad_request", message = ("duplicate request id '%s'"):format(id) }))
			return
		end
		local peer = star:get(target)
		if peer == nil then
			respond(protocol.err(id, "edit", { code = "no_peer", message = ("dm '%s' is not connected"):format(target) }))
			return
		end
		local deadlineMs = util.num(frame.deadline_ms, protocol.DEFAULT_DEADLINE_MS, 1, 3600000)
		local entry: Forwarded = {
			dm = peer.dm :: string,
			op = tostring(frame.op),
			body = if type(frame.body) == "table" then frame.body else {},
			timer = nil,
		}
		forwarded[id] = entry
		if not star:sendText(peer, text) then
			forwarded[id] = nil
			respond(protocol.err(id, "edit", { code = "disconnected", message = ("could not send to '%s'"):format(target) }))
			return
		end
		-- Protocol Notes: `timeout` 5 s after deadline_ms if the agent never answered.
		entry.timer = task.delay(deadlineMs / 1000 + FORWARD_GRACE_S, function()
			if forwarded[id] ~= entry then
				return
			end
			forwarded[id] = nil
			respond(protocol.err(id, entry.dm, { code = "timeout", message = "agent did not answer before the deadline" }))
		end)
	end

	local function cancelForwarded(id: string, text: string?)
		local fwd = forwarded[id]
		if fwd == nil then
			return
		end
		local peer = star:get(fwd.dm)
		if peer then
			if text then
				star:sendText(peer, text)
			else
				star:send(peer, { v = protocol.VERSION, kind = "cancel", id = id })
			end
		end
	end

	local function handleBridgeFrame(frame: { [string]: any }, text: string)
		local kind = frame.kind
		if kind == "req" then
			local target = routeTarget(frame)
			if target == "edit" then
				dispatcher:handle(frame)
			else
				forward(frame, text, target)
			end
		elseif kind == "cancel" then
			dispatcher:handle(frame)
			if type(frame.id) == "string" then
				cancelForwarded(frame.id, text)
			end
		elseif kind == "cancel_all" then
			dispatcher:cancelAll()
			star:broadcast({ v = protocol.VERSION, kind = "cancel_all" })
		elseif kind == "ack" then
			if type(frame.upto) == "number" then
				events.ack(frame.upto)
			end
		elseif kind == "persist_sync" then
			-- Bare-frame form (no response expected); the `req` form answers through the dispatcher.
			local ok, err = pcall(applyPersistSync, frame.controllers)
			if not ok then
				warnLimited("persist_sync frame ignored: " .. tostring(if type(err) == "table" then err.message else err))
			end
		end
		-- Other kinds (hello_ack / bundle / chunk are consumed by the bootstrap) are ignored.
	end

	local offFrame = link.onFrame(function(frame, text)
		if not running then
			return
		end
		local ok, err = pcall(handleBridgeFrame, frame, text)
		if not ok then
			warnLimited("frame handling failed: " .. tostring(err))
		end
	end)

	-- Selection events, throttled to one per SELECTION_THROTTLE_S.
	local selectionPending = false
	local selectionConn = Selection.SelectionChanged:Connect(function()
		if selectionPending then
			return
		end
		selectionPending = true
		task.delay(SELECTION_THROTTLE_S, function()
			selectionPending = false
			if running then
				pcall(function()
					events.emit({ type = "selection", paths = selectionPaths() })
				end)
			end
		end)
	end)

	logs:seedHistory(200)
	logs:attach(events.emit)
	journal:start(events.emit)
	star:start()
	playtest:start()

	-- Heartbeat every 10 s (peer and playtest changes send extra ones).
	local hbThread = task.spawn(function()
		while running do
			pcall(heartbeat)
			task.wait(protocol.HB_INTERVAL)
		end
	end)

	events.emit({ type = "log", level = "info", msg = ("hub runtime started (bundle %s); persisted controllers arrive with the bridge's persist_sync"):format(string.sub(ctx.bundleHash, 1, 16)) })
	heartbeat()

	-- game.Name is only "PlaceN" for a cloud place; the real name comes from the marketplace, looked up
	-- in the background (it may be unavailable offline) and announced with the next heartbeat.
	if game.PlaceId > 0 then
		task.spawn(function()
			local t0 = os.clock()
			local ok, info = pcall(MarketplaceService.GetProductInfo, MarketplaceService, game.PlaceId)
			if not running or os.clock() - t0 > PLACE_NAME_TIMEOUT_S then
				return
			end
			if ok and type(info) == "table" and type(info.Name) == "string" and info.Name ~= "" then
				placeName = info.Name
				pcall(heartbeat)
			end
		end)
	end

	local function countKeys(t: { [string]: any }): number
		local n = 0
		for _ in pairs(t) do
			n += 1
		end
		return n
	end

	-- A different bridge process took over: nothing it never issued can be answered to it, and its
	-- predecessor would have sent cancel_all on a clean exit, so treat the takeover the same way.
	local function bridgeChanged(newId: string)
		print(("[StudioLive] bridge %s replaced %s; cancelling %d local and %d forwarded requests"):format(
			newId,
			tostring(bridgeId),
			countKeys(dispatcher.inflight),
			countKeys(forwarded)
		))
		bridgeId = newId
		dispatcher:cancelAll()
		for id in pairs(forwarded) do
			cancelForwarded(id, nil)
			dropForwarded(id)
		end
	end

	local runtime: Runtime = {
		stop = function()
			if not running then
				return
			end
			running = false
			pcall(task.cancel, hbThread)
			dispatcher:failAll("disconnected", "hub runtime stopping")
			dispatcher:stop()
			for id, entry in pairs(forwarded) do
				dropForwarded(id)
				respond(protocol.err(id, entry.dm, { code = "disconnected", message = "hub runtime stopping" }))
			end
			for id, entry in pairs(pendingInternal) do
				pendingInternal[id] = nil
				pcall(task.spawn, entry.thread, nil)
			end
			offFrame()
			selectionConn:Disconnect()
			playtest:stopWatching()
			star:stop()
			logs:detach()
			journal:stop()
			fps:stop()
			-- Last: from here on no leftover thread of this runtime can emit an event or an hb whose seq
			-- would collide with the replacement runtime's (it starts at lastSeq()).
			events.stop()
		end,
		relinked = function(ackUpto: number?, newBridgeId: string?)
			if not running then
				return
			end
			if type(newBridgeId) == "string" and bridgeId ~= nil and newBridgeId ~= bridgeId then
				bridgeChanged(newBridgeId)
			elseif type(newBridgeId) == "string" then
				bridgeId = newBridgeId
			end
			local flushed = link.flushQueued()
			local n = events.resend(ackUpto)
			heartbeat()
			if n > 0 or flushed > 0 then
				print(("[StudioLive] relinked; re-sent %d unacked events, %d queued responses"):format(n, flushed))
			end
		end,
		lastSeq = events.lastSeq,
	}
	return runtime
end

return hub
