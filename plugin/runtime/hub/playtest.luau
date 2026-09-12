--[[
	Playtest lifecycle on the hub (§4.3 start / stop / status / list / add_players) plus the
	persisted-controller re-install. Persisted controllers (hub/persist.luau, fed by the bridge's
	`persist_sync`) are re-installed per peer as soon as that DM's runtime says hello — whether the
	playtest was started through `playtest start`, from Studio's own Play button, or by another
	tool entirely. `synced[dm][name]` remembers what a connected peer already has, so a
	`persist_sync` that arrives after the peer's hello installs only what is missing and never
	restarts a controller that is already running.

	Three ways a test becomes known here:
	- `start` (play | run | multiplayer): we call StudioTestService and wait for the peers.
	- EditModeActive flips false (Studio's Play/Run button): `starting`, then `running` once
	  the server peer is up and the mode has been inferred.
	- A server peer says hello while nothing is starting or running (a multiplayer test started
	  elsewhere leaves the edit DM in edit mode, so EditModeActive never flips): `running` at
	  once, mode inferred from the clients that appear within CLIENT_GRACE_S.

	Every state change (starting / running / stopping / stopped / failed) emits a `playtest`
	event and triggers an extra `hb` through `onChange`.
]]

local StudioTestService = game:GetService("StudioTestService")

local util = require(script.Parent.Parent.shared.util)
local types = require(script.Parent.Parent.shared.types)

local Persist = require(script.Parent.persist)
local Star = require(script.Parent.star)

type Control = types.Control

local Playtest = {}
Playtest.__index = Playtest

local PEER_WAIT_S = 20
-- Multiplayer clients are separate Studio processes that spawn 2–4 s apart.
local MULTI_WAIT_S = 40
local ADD_PLAYERS_WAIT_S = 40
local STOP_WAIT_S = 15
-- After the server peer appears, how long to wait for a client before inferring the mode.
local CLIENT_GRACE_S = 3
-- After the server peer of an externally started test drops, how long before declaring it ended.
local SERVER_GONE_GRACE_S = 1
local MAX_PLAYERS = 8
local DEFAULT_PLAYERS = 2
-- Peers of a finished test may still be closing when the next `start` arrives (client Studio
-- processes exit a few seconds after the server): how long `start` waits for them to go.
local STALE_PEER_WAIT_S = 5

local NO_PEER_HINT = "enable the Studio setting \"Load User Plugins In Run Modes\" and make sure the Studio Live bootstrap plugin is installed"
local NO_PEER_HELP = "no play-DM peer appeared within %d s; " .. NO_PEER_HINT .. "."
-- Without a server peer nothing can end the test from here (RunService:Stop() would not revert changes).
local STILL_RUNNING = "The playtest is still running — press Stop in Studio."

export type Request = (dm: string, op: string, body: { [string]: any }, timeoutS: number) -> (boolean, any)

export type Playtest = typeof(setmetatable(
	{} :: {
		star: Star.Star,
		emit: (ev: { [string]: any }) -> number,
		request: Request,
		persist: Persist.Persist,
		onChange: (() -> ())?,
		running: boolean,
		starting: boolean,
		mode: string?,
		players: number?,
		startedAt: number?,
		externallyStarted: boolean,
		-- Bumped on every start / detect / end so background inference threads can tell they are stale.
		gen: number,
		connections: { RBXScriptConnection },
		-- Persisted controller names each connected peer already received (cleared when it leaves).
		synced: { [string]: { [string]: boolean } },
		-- Persisted installs that failed on a connected peer: dm → name → { code, error }. A later
		-- persist_sync skips them unless the entry's code changed; a fresh peer hello retries.
		failed: { [string]: { [string]: { code: string, error: string } } },
	},
	Playtest
))

function Playtest.new(star: Star.Star, emit: (ev: { [string]: any }) -> number, request: Request, persist: Persist.Persist): Playtest
	local self = setmetatable({
		star = star,
		emit = emit,
		request = request,
		persist = persist,
		onChange = nil,
		running = false,
		starting = false,
		mode = nil,
		players = nil,
		startedAt = nil,
		externallyStarted = false,
		gen = 0,
		connections = {},
		synced = {},
		failed = {},
	}, Playtest)
	return self
end

local function editModeActive(): boolean
	local ok, v = pcall(function()
		return StudioTestService.EditModeActive
	end)
	return if ok then v == true else true
end

local function normaliseMode(v: any): string
	if v == "run" or v == "multiplayer" then
		return v
	end
	return "play"
end

-- Emits a `playtest` state event and asks the hub for an extra heartbeat (§2.7).
function Playtest.emitState(self: Playtest, ev: { [string]: any })
	ev.type = "playtest"
	self.emit(ev)
	if self.onChange then
		pcall(self.onChange)
	end
end

function Playtest.reset(self: Playtest)
	self.gen += 1
	self.running = false
	self.starting = false
	self.mode = nil
	self.players = nil
	self.startedAt = nil
	self.externallyStarted = false
end

-- Watches EditModeActive so playtests started/stopped from Studio's own buttons are tracked too.
function Playtest.start(self: Playtest)
	local ok, sig = pcall(function()
		return StudioTestService:GetPropertyChangedSignal("EditModeActive")
	end)
	if ok then
		table.insert(
			self.connections,
			sig:Connect(function()
				if editModeActive() then
					self:onEnded()
				elseif not self.running and not self.starting then
					self:onStartedFromStudio()
				end
			end)
		)
	end
	if not editModeActive() then
		-- Hub (re)started inside a running test: the peers re-hello after the bundle push, and the
		-- server's hello infers the mode (see onPeerConnected).
		self.gen += 1
		self.running = true
		self.externallyStarted = true
		self.startedAt = os.clock()
	end
end

-- Studio's Play/Run button: report `starting` now and `running` once the server peer is up.
function Playtest.onStartedFromStudio(self: Playtest)
	self.gen += 1
	local myGen = self.gen
	self.starting = true
	self.running = false
	self.mode = nil
	self.players = nil
	self.startedAt = os.clock()
	self.externallyStarted = true
	self:emitState({ state = "starting", detail = "started from Studio" })
	task.spawn(function()
		local deadline = os.clock() + PEER_WAIT_S
		while self.gen == myGen and os.clock() < deadline and self.star:get("server") == nil do
			task.wait(0.1)
		end
		if self.gen ~= myGen then
			return -- ended (or taken over) meanwhile
		end
		if self.star:get("server") == nil then
			self.starting = false
			self.running = true
			self.mode = "run"
			self:emitState({ state = "running", mode = "run", detail = "started from Studio; no play-DM peer within " .. PEER_WAIT_S .. " s" })
			return
		end
		self:inferAndRun(myGen, "started from Studio")
	end)
end

-- A server peer said hello while nothing was starting or running: a test this hub did not start
-- (typically a multiplayer test, which leaves the edit DM in edit mode).
function Playtest.onServerDetected(self: Playtest)
	self.gen += 1
	local myGen = self.gen
	self.running = true
	self.starting = false
	self.mode = nil
	self.players = nil
	self.startedAt = os.clock()
	self.externallyStarted = true
	task.spawn(function()
		self:inferAndRun(myGen, "detected: server peer appeared")
	end)
end

-- Waits CLIENT_GRACE_S for clients, then decides play / run / multiplayer and reports `running`.
function Playtest.inferAndRun(self: Playtest, myGen: number, detail: string)
	local clientDeadline = os.clock() + CLIENT_GRACE_S
	while self.gen == myGen and os.clock() < clientDeadline and self.star:get("client") == nil do
		task.wait(0.1)
	end
	if self.gen ~= myGen then
		return
	end
	local mode, players = self:inferMode()
	self.starting = false
	self.running = true
	self.mode = mode
	self.players = players
	self:emitState({ state = "running", mode = mode, players = players, detail = detail })
end

-- run: no clients; play: a client with a real user id; multiplayer: only test players (userId ≤ 0).
function Playtest.inferMode(self: Playtest): (string, number?)
	local clients = self.star:clients()
	if #clients == 0 then
		return "run", nil
	end
	for _, c in ipairs(clients) do
		if type(c.userId) == "number" and c.userId > 0 then
			return "play", nil
		end
	end
	return "multiplayer", #clients
end

function Playtest.stopWatching(self: Playtest)
	-- Runtime stop (bundle swap): every background inference / completion thread must find a stale gen.
	self.gen += 1
	for _, c in ipairs(self.connections) do
		pcall(c.Disconnect, c)
	end
	self.connections = {}
end

function Playtest.onEnded(self: Playtest)
	if not self.running and not self.starting then
		return
	end
	local mode = self.mode
	self:reset()
	self:emitState({ state = "stopped", mode = mode })
end

function Playtest.info(self: Playtest): { [string]: any }
	return {
		running = self.running,
		starting = self.starting,
		mode = self.mode,
		players = self.players,
		startedAt = self.startedAt,
		externallyStarted = self.externallyStarted,
	}
end

function Playtest.markSynced(self: Playtest, dm: string, name: string, present: boolean)
	local set = self.synced[dm]
	if set == nil then
		if not present then
			return
		end
		set = {}
		self.synced[dm] = set
	end
	set[name] = if present then true else nil
end

function Playtest.isSynced(self: Playtest, dm: string, name: string): boolean
	local set = self.synced[dm]
	return set ~= nil and set[name] == true
end

-- Records / clears a failed persisted install on a peer (see `failed`).
function Playtest.markFailed(self: Playtest, dm: string, name: string, code: string?, err: string?)
	local set = self.failed[dm]
	if code == nil then
		if set then
			set[name] = nil
		end
		return
	end
	if set == nil then
		set = {}
		self.failed[dm] = set
	end
	set[name] = { code = code, error = err or "install failed" }
end

-- The failure recorded for a persisted entry on a peer, if its code is still the one that failed.
function Playtest.failedFor(self: Playtest, dm: string, entry: Persist.Entry): string?
	local set = self.failed[dm]
	local f = if set then set[entry.name] else nil
	if f ~= nil and f.code == entry.code then
		return f.error
	end
	return nil
end

-- Sends one persisted install to a connected peer (background); failures become `controller` events
-- and are remembered so the sync after every later install / uninstall does not retry them.
function Playtest.installPersisted(self: Playtest, dm: string, entry: Persist.Entry, why: string)
	local name, code = entry.name, entry.code
	self:markSynced(dm, name, true)
	self:markFailed(dm, name, nil)
	task.spawn(function()
		local ok, err = self.request(dm, "playtest", { action = "install", dm = dm, name = name, code = code, persist = true }, 10)
		if not ok then
			local message = tostring(if type(err) == "table" then err.message else err)
			self:markSynced(dm, name, false)
			self:markFailed(dm, name, code, util.truncate(message, 512))
			self.emit({ type = "controller", name = name, dm = dm, state = "error", detail = ("persisted re-install on %s (%s) failed: %s"):format(dm, why, message) })
		end
	end)
end

-- `persist_sync` from the bridge: the list replaces the registry; peers already connected receive
-- the entries they do not have yet (a hello that beat the sync, or a controller added from another
-- session of the same place) — except entries whose install already failed on that peer with the
-- same code (retried on the peer's next hello, or when the code changes). Returns entries accepted,
-- rejected, and installs issued.
function Playtest.onPersistSync(self: Playtest, list: { any }): (number, number, number)
	local accepted, rejected = self.persist:replaceAll(list)
	local issued = 0
	for _, peer in ipairs(self.star:list()) do
		local dm = peer.dm
		if peer.connected and type(dm) == "string" then
			for _, entry in ipairs(self.persist:forDm(dm)) do
				if not self:isSynced(dm, entry.name) and self:failedFor(dm, entry) == nil then
					self:installPersisted(dm, entry, "persist_sync")
					issued += 1
				end
			end
		end
	end
	return accepted, rejected, issued
end

-- A play-DM runtime is up: install every controller persisted for that dm, then update the
-- playtest bookkeeping (detection of tests started elsewhere, mode revision, player counts).
function Playtest.onPeerConnected(self: Playtest, dm: string)
	self.synced[dm] = nil
	self.failed[dm] = nil
	for _, entry in ipairs(self.persist:forDm(dm)) do
		self:installPersisted(dm, entry, "peer hello")
	end
	if dm == "server" then
		if not self.running and not self.starting then
			self:onServerDetected()
		elseif self.running and self.mode == nil and not self.starting then
			-- Hub restarted inside a test it never saw start: infer now that the server is back.
			local myGen = self.gen
			task.spawn(function()
				self:inferAndRun(myGen, "server peer re-connected")
			end)
		end
	elseif string.match(dm, "^client:%d+$") and self.running and not self.starting then
		local mode, players = self:inferMode()
		if self.mode == "run" and mode ~= "run" then
			-- A client that took longer than the grace period: the earlier `run` verdict was wrong.
			self.mode = mode
			self.players = players
			self:emitState({ state = "running", mode = mode, players = players, detail = ("mode revised: client %s joined"):format(dm) })
		elseif self.mode == "multiplayer" then
			self.players = math.max(self.players or 0, players or 0)
			if self.onChange then
				pcall(self.onChange)
			end
		end
	end
end

-- The server peer of a test whose edit DM never left edit mode (multiplayer / external) is the
-- only sign that the test ended; play/run tests are ended by the EditModeActive signal instead.
function Playtest.onPeerDisconnected(self: Playtest, dm: string)
	self.synced[dm] = nil
	self.failed[dm] = nil
	if dm ~= "server" or not (self.running or self.starting) then
		return
	end
	local myGen = self.gen
	task.delay(SERVER_GONE_GRACE_S, function()
		if self.gen == myGen and (self.running or self.starting) and editModeActive() and self.star:get("server") == nil then
			self:onEnded()
		end
	end)
end

-- An acknowledged `install persist=true` relayed for the bridge: the peer has it now.
function Playtest.remember(self: Playtest, dm: string, name: string, code: string)
	self.persist:remember(dm, name, code)
	self:markSynced(dm, name, true)
	self:markFailed(dm, name, nil)
end

-- An acknowledged `uninstall`, or an install of the same name without persist (the latest install decides).
function Playtest.forget(self: Playtest, dm: string, name: string)
	self.persist:forget(dm, name)
	self:markSynced(dm, name, false)
	self:markFailed(dm, name, nil)
end

-- `status` → persisted: the registry, each entry annotated with `error` when its last install on a
-- connected peer failed (and will not be retried by a sync until the code changes or the peer re-hellos).
function Playtest.persistedStatus(self: Playtest): { { [string]: any } }
	local out = self.persist:list()
	for _, item in ipairs(out) do
		local entry = self.persist:get(item.dm, item.name)
		local err = if entry then self:failedFor(item.dm, entry) else nil
		if err ~= nil then
			item.error = err
		end
	end
	return out
end

-- True once the peers a `start` in `mode` waits for are all connected.
function Playtest.peersReady(self: Playtest, mode: string, players: number): boolean
	if self.star:get("server") == nil then
		return false
	end
	if mode == "run" then
		return true
	elseif mode == "play" then
		return self.star:get("client:1") ~= nil
	end
	return self.star:countClients() >= players
end

function Playtest.doStart(self: Playtest, body: { [string]: any }, ctl: Control): { [string]: any }
	local mode = normaliseMode(body.mode)
	local players = math.floor(util.num(body.players, DEFAULT_PLAYERS, 1, MAX_PLAYERS))
	if self.starting then
		error(util.perr("busy", "a playtest is already starting"), 0)
	end
	if self.running or not editModeActive() then
		error(util.perr("busy", "a playtest is already running; stop it first"), 0)
	end
	if self.star:get("server") ~= nil then
		error(util.perr("busy", "a play-DM server peer is already connected (a test started elsewhere?); stop it first"), 0)
	end
	-- Client peers of the previous test that are still closing would satisfy peersReady, be reported
	-- as this test's peers and keep the numbering going (client:N+1…): wait for them, then refuse.
	if self.star:hasConnectedPeers() then
		local until_ = os.clock() + STALE_PEER_WAIT_S
		while os.clock() < until_ and self.star:hasConnectedPeers() do
			ctl.checkCancel()
			if self.star:get("server") ~= nil then
				error(util.perr("busy", "a play-DM server peer connected meanwhile (a test started elsewhere?); stop it first"), 0)
			end
			task.wait(0.1)
		end
		if self.star:hasConnectedPeers() then
			local names = {}
			for _, p in ipairs(self.star:list()) do
				if p.connected then
					table.insert(names, tostring(p.dm))
				end
			end
			error(util.perr("busy", ("peers of a previous test are still connected after %d s (%s); wait for them to close, or stop that test first"):format(STALE_PEER_WAIT_S, table.concat(names, ", "))), 0)
		end
	end
	-- New test generation: its clients are client:1.. again.
	self.star:resetClientNumbering()
	local t0 = os.clock()
	self.gen += 1
	local myGen = self.gen
	self.starting = true
	self.mode = mode
	self.players = if mode == "multiplayer" then players else nil
	self.startedAt = t0
	self.externallyStarted = false
	-- Whatever ends this handler (deadline, hard cancel, an error below), `starting` must not stick.
	local function settle()
		if self.gen ~= myGen then
			return
		end
		self.starting = false
		self.running = not editModeActive() or self.star:get("server") ~= nil
	end
	ctl.onAbort(settle)
	self:emitState({ state = "starting", mode = mode, players = self.players })
	local failure: string? = nil
	task.spawn(function()
		-- Yields for the whole session (play / run); must never block the hub.
		local ok, err = pcall(function()
			if mode == "run" then
				StudioTestService:ExecuteRunModeAsync({})
			elseif mode == "multiplayer" then
				StudioTestService:ExecuteMultiplayerTestAsync(players, {})
			else
				StudioTestService:ExecutePlayModeAsync({})
			end
		end)
		if not ok then
			failure = tostring(err)
			self:emitState({ state = "failed", mode = mode, detail = util.truncate(failure :: string, 1024) })
			if self.gen == myGen then
				self:onEnded()
			end
			return
		end
		-- Play / run: the call returns once the edit DM is back in edit mode (the EditModeActive
		-- signal normally ends the test first; this is the fallback). A multiplayer test runs in
		-- separate processes and the edit DM never leaves edit mode, so its end is the server
		-- peer going away (onPeerDisconnected) — never the return of this call.
		if mode ~= "multiplayer" then
			task.delay(0.5, function()
				if self.gen == myGen and editModeActive() and self.star:get("server") == nil then
					self:onEnded()
				end
			end)
		end
	end)
	local waitS = if mode == "multiplayer" then MULTI_WAIT_S else PEER_WAIT_S
	local okWait, waitErr = pcall(function()
		local deadline = t0 + waitS
		while os.clock() < deadline do
			ctl.checkCancel()
			if failure then
				error(util.perr("internal", ("playtest failed to start: %s"):format(failure)), 0)
			end
			if self.gen ~= myGen then
				error(util.perr("internal", "the playtest ended before its peers appeared"), 0)
			end
			if self:peersReady(mode, players) then
				break
			end
			task.wait(0.1)
		end
	end)
	settle()
	if not okWait then
		error(waitErr, 0)
	end
	local server = self.star:get("server")
	local clients = self.star:countClients()
	local note: string? = nil
	if server == nil or (mode == "play" and clients == 0) or (mode == "multiplayer" and clients == 0) then
		local message = NO_PEER_HELP:format(waitS)
		if server ~= nil then
			message ..= " The server peer is connected, so `playtest stop` can end the test."
		elseif self.running then
			message ..= " " .. STILL_RUNNING
		end
		error(util.perr("no_peer", message), 0)
	end
	if mode == "multiplayer" and clients < players then
		note = ("only %d of %d clients connected within %d s; the rest may still be starting (check `playtest status`)"):format(clients, players, waitS)
	end
	self.running = true
	self:emitState({ state = "running", mode = mode, players = self.players, detail = note })
	return {
		running = true,
		mode = mode,
		players = self.players,
		peers = self.star:list(),
		started_ms = util.round((os.clock() - t0) * 1000),
		note = note,
	}
end

-- `add_players` {count}: StudioTestService:AddPlayers, tried first in this DM (the edit DM launched
-- the test with ExecuteMultiplayerTestAsync, so it is the natural owner) and, only when that throws
-- before yielding, on the server agent. The call may yield until the clients have joined, so neither
-- answer is trusted: the peer count is the source of truth.
function Playtest.doAddPlayers(self: Playtest, body: { [string]: any }, ctl: Control): { [string]: any }
	local count = math.floor(util.num(body.count, 1, 1, MAX_PLAYERS))
	if self.star:get("server") == nil then
		error(util.perr("no_peer", "no server peer; start a multiplayer playtest first"), 0)
	end
	if self.mode ~= nil and self.mode ~= "multiplayer" then
		error(util.perr("bad_request", ("add_players needs a multiplayer playtest (current mode: %s)"):format(self.mode)), 0)
	end
	local t0 = os.clock()
	local myGen = self.gen
	local before = self.star:countClients()
	local hubOk: boolean? = nil
	local hubErr: any = nil
	task.spawn(function()
		-- pcall returns before task.spawn does only when AddPlayers throws without yielding.
		local ok, err = pcall(StudioTestService.AddPlayers, StudioTestService, count)
		hubOk = ok
		hubErr = err
	end)
	local via = "edit"
	local serverNote: string? = nil
	if hubOk == false then
		via = "server"
		local ok, res = self.request("server", "addplayers", { count = count }, math.max(5, math.min(30, ctl.remaining())))
		if not ok then
			local code = if type(res) == "table" and type(res.code) == "string" then res.code else "internal"
			local message = if type(res) == "table" then tostring(res.message) else tostring(res)
			if code ~= "timeout" then
				error(util.perr(code, ("AddPlayers(%d) failed in the edit DM (%s) and on the server agent (%s)"):format(count, tostring(hubErr), message)), 0)
			end
			-- The server agent may still be inside AddPlayers (it can yield until the clients join).
			serverNote = "the server agent did not acknowledge addplayers within its deadline; the peer count below is what actually joined"
		end
	end
	local target = before + count
	self.players = math.max(self.players or before, target)
	if self.onChange then
		pcall(self.onChange)
	end
	local deadline = t0 + ADD_PLAYERS_WAIT_S
	while os.clock() < deadline and self.star:countClients() < target do
		ctl.checkCancel()
		if self.gen ~= myGen then
			error(util.perr("internal", "the playtest ended while players were joining"), 0)
		end
		task.wait(0.1)
	end
	local joined = self.star:countClients() - before
	if joined < count then
		-- Nothing optimistic survives: report the clients that actually exist.
		self.players = math.max(before + joined, self.star:countClients())
		if self.onChange then
			pcall(self.onChange)
		end
	end
	local notes = {}
	if joined < count then
		table.insert(notes, ("only %d of %d new clients connected within %d s"):format(joined, count, ADD_PLAYERS_WAIT_S))
	end
	if via == "edit" and hubOk == false then
		table.insert(notes, ("AddPlayers threw in the edit DM after yielding: %s"):format(tostring(hubErr)))
	end
	if serverNote then
		table.insert(notes, serverNote)
	end
	return {
		added = count,
		joined = joined,
		complete = joined >= count,
		players = self.players,
		peers = self.star:list(),
		waited_ms = util.round((os.clock() - t0) * 1000),
		via = via,
		note = if #notes > 0 then table.concat(notes, "; ") else nil,
	}
end

-- Answers from the `endtest` request that do not mean "refused": the server DM tears down right
-- after EndTest (`disconnected`, `no_peer`) or simply does not answer in time (`timeout`); the end
-- signal (EditModeActive / the server peer leaving) decides those.
local ENDTEST_UNACKED = { timeout = true, disconnected = true, no_peer = true }

function Playtest.doStop(self: Playtest, ctl: Control): { [string]: any }
	local t0 = os.clock()
	local server = self.star:get("server")
	if server == nil and self.starting then
		-- A `start` is still waiting for its server peer (multiplayer Studios boot for tens of seconds).
		-- Declaring "nothing was running" here would abort that start and let the test surface later as
		-- externally started; wait for the peer instead, then end the test through it.
		local myGen = self.gen
		local deadline = t0 + STOP_WAIT_S
		while os.clock() < deadline and self.gen == myGen and self.starting and self.star:get("server") == nil do
			ctl.checkCancel()
			task.wait(0.1)
		end
		server = self.star:get("server")
		if server == nil then
			if self.gen ~= myGen or not self.starting then
				if not self.running then
					return { stopped_ms = util.round((os.clock() - t0) * 1000), note = "the playtest ended before its peers appeared" }
				end
			else
				error(util.perr("busy", ("a playtest is still starting (no server peer after %d s); retry once `playtest status` reports it running"):format(STOP_WAIT_S)), 0)
			end
		end
	end
	if server == nil then
		if editModeActive() then
			-- Nothing to end and Studio is in edit mode, whatever our flag says (a missed EditModeActive
			-- change must not turn into a "still running — press Stop" answer).
			self:onEnded()
			return { stopped_ms = 0, note = "no playtest was running" }
		end
		error(util.perr("no_peer", "no server peer to end the test from the runtime; " .. NO_PEER_HINT .. ". " .. STILL_RUNNING), 0)
	end
	-- A server peer exists: end the test regardless of our bookkeeping (it may have been started elsewhere).
	if not self.running and not self.starting then
		self.gen += 1
		self.running = true
		self.externallyStarted = true
		self.startedAt = self.startedAt or t0
	end
	local myGen = self.gen
	-- Multiplayer / external tests leave the edit DM in edit mode; then the server peer going
	-- away is the end signal, not EditModeActive.
	local editWasActive = editModeActive()
	self:emitState({ state = "stopping", mode = self.mode })
	-- The server DM tears down right after EndTest, so an answer is optional — but a refusal is not:
	-- it is recorded so the wait below can stop early and say why.
	local endtestAck = false
	local endtestErr: { [string]: any }? = nil
	task.spawn(function()
		local ok, err = self.request("server", "endtest", {}, 5)
		if ok then
			endtestAck = true
			return
		end
		local e = if type(err) == "table" then err else util.perr("internal", tostring(err))
		endtestErr = e
		if e.code == "unsupported" then
			self:emitState({ state = "failed", mode = self.mode, detail = ("server agent refused endtest: %s"):format(tostring(e.message)) })
		end
	end)
	local deadline = t0 + STOP_WAIT_S
	while os.clock() < deadline do
		ctl.checkCancel()
		local ended = if editWasActive then self.star:get("server") == nil else editModeActive()
		if ended or self.gen ~= myGen then
			self:onEnded()
			return { stopped_ms = util.round((os.clock() - t0) * 1000) }
		end
		local err = endtestErr
		if err ~= nil and not ENDTEST_UNACKED[err.code] then
			-- An explicit refusal (unsupported, internal "EndTest failed: …", …): waiting would not end it.
			error(util.perr(tostring(err.code), ("the server agent refused endtest: %s. %s"):format(tostring(err.message), STILL_RUNNING)), 0)
		end
		task.wait(0.1)
	end
	local why = if endtestAck
		then "the server agent acknowledged endtest but the test did not end"
		elseif endtestErr then ("the server agent did not acknowledge endtest (%s: %s)"):format(tostring(endtestErr.code), tostring(endtestErr.message))
		else "the server agent did not answer endtest"
	-- Recover what can be recovered: a server peer whose connection is actually dead is dropped so a
	-- later `start` is not refused with busy forever.
	local peer = self.star:get("server")
	if peer ~= nil and not self.star:checkAlive(peer) and editModeActive() then
		self:onEnded()
		error(util.perr("timeout", ("playtest did not end within %d s: %s. The server peer was unreachable and has been dropped; the hub no longer considers a test running"):format(STOP_WAIT_S, why)), 0)
	end
	error(util.perr("timeout", ("playtest did not end within %d s: %s. %s"):format(STOP_WAIT_S, why, STILL_RUNNING)), 0)
end

-- Aggregates controller lists from every connected peer.
function Playtest.listControllers(self: Playtest): { { [string]: any } }
	local out = {}
	local pending = 0
	for _, peer in ipairs(self.star:list()) do
		if peer.connected then
			pending += 1
			task.spawn(function()
				local ok, body = self.request(peer.dm, "playtest", { action = "list" }, 3)
				if ok and type(body) == "table" and type(body.controllers) == "table" then
					for _, c in ipairs(body.controllers) do
						table.insert(out, c)
					end
				end
				pending -= 1
			end)
		end
	end
	local deadline = os.clock() + 4
	while pending > 0 and os.clock() < deadline do
		task.wait(0.05)
	end
	return out
end

function Playtest.doStatus(self: Playtest): { [string]: any }
	return {
		running = self.running,
		starting = self.starting,
		mode = self.mode,
		players = self.players,
		externally_started = self.externallyStarted,
		edit_mode_active = editModeActive(),
		peers = self.star:list(),
		elapsed_s = if self.startedAt then util.round(os.clock() - self.startedAt, 1) else 0,
		controllers = self:listControllers(),
		persisted = self:persistedStatus(),
	}
end

return Playtest
