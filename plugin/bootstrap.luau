--[[
	Studio Live bootstrap (protocol.md §1) — the only code installed into Studio.
	Dependency-free: role detection, the L1 (WebSocket) / L2 (PluginConnection) hello,
	chunk reassembly, bundle → in-memory ModuleScript tree, reconnect. Everything else
	arrives from the bridge as a bundle and runs via require().
]]

local VERSION, PROTO = "1.0.0", 1
-- Rewritten by `studio-live install` when STUDIO_LIVE_PORT is set; keep it on its own line.
local DEFAULT_PORT = 47800
local CHUNK_L1, CHUNK_L2 = 512 * 1024, 16 * 1024
local BACKOFF_MIN, BACKOFF_MAX = 0.5, 5
local PROACTIVE_RECONNECT_S, CONNECT_TIMEOUT_S, PEER_WAIT_S = 25 * 60, 10, 30
local ASSEMBLY_STALE_S, LOCAL_PLAYER_WAIT_S = 120, 5

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local role = if not RunService:IsRunning() then "edit" elseif RunService:IsServer() then "server" else "client"
local session = HttpService:GenerateGUID(false)
local alive = true

local function say(msg: string)
	print("[StudioLive] " .. msg)
end

local lastWarn = -math.huge
local function softWarn(msg: string)
	if os.clock() - lastWarn >= 5 then
		lastWarn = os.clock()
		warn("[StudioLive] " .. msg)
	end
end

local function encode(v: any): string?
	local ok, text = pcall(HttpService.JSONEncode, HttpService, v)
	return if ok then text else nil
end

local function decode(text: string): { [string]: any }?
	local ok, v = pcall(HttpService.JSONDecode, HttpService, text)
	return if ok and type(v) == "table" then v else nil
end

-- Largest byte offset ≤ `to` at which `s` can be cut without splitting a UTF-8 character.
local function utf8Cut(s: string, to: number): number
	if to >= #s then
		return #s
	end
	while to > 0 do
		local b = string.byte(s, to + 1)
		if b == nil or b < 0x80 or b >= 0xC0 then
			break
		end
		to -= 1
	end
	return to
end

-- §3 chunking: split outbound frames over `limit` on character boundaries (halving the slice
-- if JSON escaping overflows), reassemble inbound `chunk` frames. Returns nil when a piece
-- cannot be encoded: a broken chunk would silently lose the whole frame on the other side.
local chunkCounter = 0
local function splitFrame(text: string, limit: number): { string }?
	if #text <= limit then
		return { text }
	end
	chunkCounter += 1
	local cid, slice = ("b-%d"):format(chunkCounter), math.max(1024, math.floor(limit * 0.75))
	for _ = 1, 6 do
		local pieces = {}
		local pos = 1
		while pos <= #text do
			local cut = utf8Cut(text, math.min(#text, pos + slice - 1))
			if cut < pos then
				cut = math.min(#text, pos + slice - 1)
			end
			table.insert(pieces, string.sub(text, pos, cut))
			pos = cut + 1
		end
		local n, out, overflow = #pieces, {}, false
		for i, piece in ipairs(pieces) do
			local encoded = encode({ v = 1, kind = "chunk", cid = cid, i = i - 1, n = n, data = piece })
			if encoded == nil then
				return nil
			end
			if #encoded > limit then
				overflow = true
				break
			end
			out[i] = encoded
		end
		if not overflow then
			return out
		end
		if slice <= 1024 then
			break
		end
		slice = math.max(1024, math.floor(slice / 2))
	end
	return nil
end

local function newAssembler(): (frame: { [string]: any }) -> string?
	local pending: { [string]: any } = {}
	return function(frame)
		local cid, i, n, data = frame.cid, frame.i, frame.n, frame.data
		if type(cid) ~= "string" or type(i) ~= "number" or type(n) ~= "number" or type(data) ~= "string" or i < 0 or i >= n then
			return nil
		end
		local entry = pending[cid]
		if entry == nil then
			entry = { parts = {}, got = 0, at = os.clock() }
			pending[cid] = entry
			-- Bound memory: forget assemblies whose sender gave up.
			for otherId, other in pairs(pending) do
				if os.clock() - other.at > ASSEMBLY_STALE_S then
					pending[otherId] = nil
				end
			end
		end
		if entry.parts[i + 1] == nil then
			entry.got += 1
		end
		entry.parts[i + 1] = data
		if entry.got < n then
			return nil
		end
		pending[cid] = nil
		return table.concat(entry.parts)
	end
end

-- Link object handed to the runtime (§1.1 step 3); survives runtime reloads.
local function newLink(rawSend: (string) -> boolean, isOpen: () -> boolean, chunkLimit: number)
	local listeners: { [(string, { [string]: any }?) -> ()]: boolean } = {}
	local counters = { sent = 0, received = 0, bytesOut = 0, bytesIn = 0, chunksIn = 0, chunksOut = 0, reconnects = 0, unsendable = 0 }
	local assemble = newAssembler()
	local link = { isOpen = isOpen, counters = counters }
	function link.send(text: string): boolean
		if type(text) ~= "string" or not isOpen() then
			return false
		end
		local pieces = splitFrame(text, chunkLimit)
		if pieces == nil then
			counters.unsendable += 1
			softWarn("dropped an outbound frame that could not be chunked")
			return false
		end
		for _, piece in ipairs(pieces) do
			if not rawSend(piece) then
				return false
			end
		end
		counters.sent, counters.bytesOut = counters.sent + 1, counters.bytesOut + #text
		counters.chunksOut += if #pieces > 1 then #pieces else 0
		return true
	end
	function link.onFrame(fn: (string, { [string]: any }?) -> ()): () -> ()
		listeners[fn] = true
		return function()
			listeners[fn] = nil
		end
	end
	function link.stats()
		return table.clone(counters)
	end
	-- Whole frame text + decoded table, or nil while a chunked frame is incomplete.
	function link.receive(text: string): (string?, { [string]: any }?)
		counters.received, counters.bytesIn = counters.received + 1, counters.bytesIn + #text
		local frame = decode(text)
		if frame == nil then
			softWarn("dropped undecodable frame")
			return nil, nil
		elseif frame.kind ~= "chunk" then
			return text, frame
		end
		counters.chunksIn += 1
		local whole = assemble(frame)
		return whole, if whole then decode(whole) else nil
	end
	-- Frames that arrive while a bundle is starting are queued so none is lost if start() yields.
	local queue: { { string | { [string]: any }? } }? = nil
	function link.dispatch(text: string, frame: { [string]: any }?)
		if queue then
			table.insert(queue, { text, frame })
			return
		end
		for fn in pairs(listeners) do
			local ok, err = pcall(fn, text, frame)
			if not ok then
				softWarn("frame listener failed: " .. tostring(err))
			end
		end
	end
	function link.whileStarting(fn: () -> boolean): boolean
		local outermost = queue == nil
		if outermost then
			queue = {}
		end
		local ok, result = pcall(fn)
		if outermost then
			local queued = queue :: { any }
			queue = nil
			for _, item in ipairs(queued) do
				link.dispatch(item[1], item[2])
			end
		end
		if not ok then
			softWarn("bundle start failed: " .. tostring(result))
			return false
		end
		return result == true
	end
	return link
end

-- Runtime lifecycle -----------------------------------------------------------

local runtime: { [string]: any }? = nil
-- Claimed before start() runs, so a same-hash bundle re-delivered while start() yields is a no-op.
local runtimeHash: string? = nil
local runtimeTree: Instance? = nil
local lastSeq = 0

local function currentLastSeq(): number
	if runtime and type(runtime.lastSeq) == "function" then
		local ok, n = pcall(runtime.lastSeq)
		if ok and type(n) == "number" then
			lastSeq = n
		end
	end
	return lastSeq
end

local function stopRuntime()
	if runtime then
		currentLastSeq()
		pcall(runtime.stop)
	end
	runtime, runtimeHash = nil, nil
	if runtimeTree then
		runtimeTree:Destroy()
		runtimeTree = nil
	end
end

-- Path a/b/c → Folder a → Folder b → ModuleScript c; a segment "init" is a ModuleScript named init.
local function buildTree(bundle: { [string]: any }): (ModuleScript?, Instance?, string?)
	local root = Instance.new("Folder")
	root.Name = "StudioLiveRuntime"
	for path, source in pairs(bundle.modules) do
		if type(path) ~= "string" or type(source) ~= "string" then
			root:Destroy()
			return nil, nil, "bundle modules must map path → source"
		end
		local segs = string.split(path, "/")
		local parent: Instance = root
		for i = 1, #segs - 1 do
			local f = parent:FindFirstChild(segs[i])
			if f == nil then
				f = Instance.new("Folder")
				f.Name, f.Parent = segs[i], parent
			elseif not f:IsA("Folder") then
				root:Destroy()
				return nil, nil, ("bundle path conflict at '%s'"):format(path)
			end
			parent = f :: Instance
		end
		local leaf = Instance.new("ModuleScript")
		leaf.Name, leaf.Source, leaf.Parent = segs[#segs], source, parent
	end
	local node: Instance? = root
	for _, seg in ipairs(string.split(tostring(bundle.entry), "/")) do
		node = if node then node:FindFirstChild(seg) else nil
	end
	if node == nil or not node:IsA("ModuleScript") then
		root:Destroy()
		return nil, nil, ("bundle entry '%s' not found"):format(tostring(bundle.entry))
	end
	return node, root, nil
end

-- Starts (or re-links) a bundle; returns true when a runtime is running (or starting) afterwards.
local function startBundle(bundle: { [string]: any }, link: any, extra: { [string]: any }): boolean
	if type(bundle.hash) ~= "string" or type(bundle.entry) ~= "string" or type(bundle.modules) ~= "table" then
		softWarn("malformed bundle frame")
		return false
	end
	if runtimeHash == bundle.hash then
		if runtime then
			pcall(runtime.relinked, extra.ackUpto, extra.bridgeId)
		end
		return true
	end
	stopRuntime()
	local entry, root, err = buildTree(bundle)
	if entry == nil or root == nil then
		softWarn(err or "bundle build failed")
		return false
	end
	runtimeHash = bundle.hash
	local ok, rt = pcall(function()
		local mod = require(entry) :: any
		assert(type(mod) == "table" and type(mod.start) == "function", "entry must return { start = function(ctx) }")
		return mod.start({
			plugin = plugin,
			role = role,
			session = extra.session or session,
			link = link,
			bundleHash = bundle.hash,
			bootstrapVersion = VERSION,
			bundle = bundle,
			lastSeq = lastSeq,
			ackUpto = extra.ackUpto,
			bridgeId = extra.bridgeId,
			hubTargetId = extra.hubTargetId,
			dm = extra.dm,
		})
	end)
	if not ok or type(rt) ~= "table" then
		if runtimeHash == bundle.hash then
			runtimeHash = nil
		end
		root:Destroy()
		softWarn("runtime start failed: " .. tostring(rt))
		return false
	end
	if runtimeHash ~= bundle.hash then
		-- Another bundle claimed the slot while start() yielded; this one is the stale one.
		pcall(rt.stop)
		root:Destroy()
		return false
	end
	runtime, runtimeTree = rt, root
	return true
end

-- Edit DM: L1 WebSocket to the bridge ---------------------------------------------

local function editMain()
	local ws: any = nil
	local wsOpen = false
	local gen, attempt = 0, 0
	local proactive, announced = false, false
	local lastAck: { [string]: any }? = nil

	local function url(): string
		return ("ws://127.0.0.1:%d/studio"):format(DEFAULT_PORT)
	end

	-- `wsOpen` is set inside Opened itself, so hello goes out even if ConnectionState still reads Connecting there.
	local link = newLink(function(text)
		return ws ~= nil and (pcall(ws.Send, ws, text))
	end, function()
		return ws ~= nil and (wsOpen or ws.ConnectionState == Enum.WebStreamClientState.Open)
	end, CHUNK_L1)

	local function sendHello()
		local okVer, ver = pcall(version)
		local text = encode({
			v = 1, kind = "hello", proto = PROTO, bootstrap = VERSION, role = "edit", session = session,
			studio = { version = if okVer then ver else "unknown", placeId = game.PlaceId, placeName = game.Name, dataModelName = game.Name },
			lastSeq = currentLastSeq(),
			bundleHash = runtimeHash,
		})
		if text then
			link.send(text)
		end
	end

	local connect
	local function onClosed(reason: string)
		if ws == nil then
			return
		end
		gen, ws, wsOpen = gen + 1, nil, false
		link.counters.reconnects += 1
		if announced then
			say("disconnected (" .. reason .. "); reconnecting")
			announced = false
		end
		local delay = 0.1
		if not proactive then
			attempt += 1
			delay = math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ^ (attempt - 1)) * (0.75 + math.random() * 0.5)
		end
		proactive = false
		task.delay(delay, function()
			if alive and ws == nil then
				connect()
			end
		end)
	end

	local function started(bundle: { [string]: any })
		local extra = { ackUpto = if lastAck then lastAck.ackUpto else nil, bridgeId = if lastAck then lastAck.bridgeId else nil }
		local ok = link.whileStarting(function()
			return startBundle(bundle, link, extra)
		end)
		if ok and not announced then
			announced = true
			say(("connected to %s (session %s)"):format(url(), session))
		end
	end

	local function handleFrame(text: string)
		local whole, frame = link.receive(text)
		if whole == nil or frame == nil then
			return
		end
		if frame.kind == "hello_ack" then
			lastAck, attempt = frame, 0
			if frame.proto ~= PROTO then
				softWarn(("bridge proto %s ≠ %d"):format(tostring(frame.proto), PROTO))
			end
			if type(frame.bundle) == "table" then
				started(frame.bundle)
			end
		elseif frame.kind == "bundle" then
			started(frame)
		elseif frame.kind == "error" then
			softWarn(("bridge error %s: %s"):format(tostring(frame.code), tostring(frame.message)))
		else
			link.dispatch(whole, frame)
		end
	end

	connect = function()
		if not alive or ws ~= nil then
			return
		end
		gen += 1
		local myGen = gen
		-- Callbacks from a superseded socket are ignored.
		local function current(fn: (...any) -> ()): (...any) -> ()
			return function(...)
				if myGen == gen then
					fn(...)
				end
			end
		end
		local ok, client = pcall(HttpService.CreateWebStreamClient, HttpService, Enum.WebStreamClientType.WebSocket, { Url = url() })
		if not ok or client == nil then
			softWarn("CreateWebStreamClient failed: " .. tostring(client))
			attempt += 1
			task.delay(math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ^ (attempt - 1)), connect)
			return
		end
		ws = client
		client.Opened:Connect(current(function()
			wsOpen = true
			sendHello()
		end))
		client.MessageReceived:Connect(current(function(text: string)
			-- task.spawn keeps a yielding listener from stalling delivery; order is preserved.
			task.spawn(function()
				local okH, err = pcall(handleFrame, text)
				if not okH then
					softWarn("frame handling failed: " .. tostring(err))
				end
			end)
		end))
		client.Closed:Connect(current(function()
			onClosed("closed")
		end))
		client.Error:Connect(current(function(code, message)
			onClosed(("error %s %s"):format(tostring(code), tostring(message)))
		end))
		task.delay(CONNECT_TIMEOUT_S, current(function()
			if not wsOpen then
				pcall(client.Close, client)
				onClosed("connect timeout")
			end
		end))
		task.delay(PROACTIVE_RECONNECT_S, current(function()
			-- Studio may close streams at 30 min; reconnect on our own terms first. Requests in
			-- flight survive: the runtime queues their responses until the new socket is up.
			proactive = true
			pcall(client.Close, client)
			onClosed("scheduled refresh")
		end))
	end

	plugin.Unloading:Connect(function()
		alive = false
		stopRuntime()
		gen += 1
		if ws then
			pcall(ws.Close, ws)
			ws, wsOpen = nil, false
		end
	end)
	connect()
end

-- Play DMs: L2 PluginConnection to the hub -------------------------------------------

local function playMain()
	local okSvc, PCS = pcall(game.GetService, game, "PluginConnectionService")
	if not okSvc or PCS == nil then
		return
	end
	local conn: any = nil
	local watcher = PCS.Connected:Connect(function(c)
		if conn == nil and c.Type == Enum.PluginConnectionTargetType.Edit then
			conn = c
		end
	end)
	local deadline = os.clock() + PEER_WAIT_S
	while conn == nil and alive and os.clock() < deadline do
		local ok, list = pcall(PCS.GetPluginConnectionsOfType, PCS, Enum.PluginConnectionTargetType.Edit)
		if ok and type(list) == "table" and list[1] ~= nil then
			conn = list[1]
		else
			task.wait(0.05)
		end
	end
	watcher:Disconnect()
	if conn == nil or not alive then
		return -- no hub yet; a hub that starts later probes us and we answer with hello
	end

	local link = newLink(function(text)
		return (pcall(conn.SendMessage, conn, text))
	end, function()
		return conn.Connected == true
	end, CHUNK_L2)
	local hubAck: { [string]: any }? = nil
	local announced = false
	local helloed = false

	-- Clients wait (briefly) for LocalPlayer so the hello carries userId / playerName.
	local function waitForLocalPlayer()
		local waitUntil = os.clock() + LOCAL_PLAYER_WAIT_S
		while role == "client" and Players.LocalPlayer == nil and os.clock() < waitUntil do
			task.wait(0.05)
		end
	end

	local function sendHello()
		local hello: { [string]: any } = { v = 1, kind = "hello", proto = PROTO, bootstrap = VERSION, role = role, targetId = tostring(conn.TargetId), bundleHash = runtimeHash }
		local lp = Players.LocalPlayer
		if role == "client" and lp then
			hello.userId, hello.playerName = lp.UserId, lp.Name
		end
		local text = encode(hello)
		if text and link.send(text) then
			helloed = true
		end
	end

	local function handleFrame(text: string)
		local whole, frame = link.receive(text)
		if whole == nil or frame == nil then
			return
		end
		if frame.kind == "hello_ack" then
			hubAck = frame
		elseif frame.kind == "probe" then
			waitForLocalPlayer()
			sendHello()
		elseif frame.kind == "bundle" then
			local extra = { dm = if hubAck then hubAck.dm else nil, session = if hubAck then hubAck.session else nil, hubTargetId = tostring(conn.TargetId) }
			local ok = link.whileStarting(function()
				return startBundle(frame, link, extra)
			end)
			if ok and not announced then
				announced = true
				say(("connected to hub as %s"):format(tostring(extra.dm or role)))
			end
		else
			link.dispatch(whole, frame)
		end
	end

	-- Bind BEFORE hello (§1.2 step 2); pre-bind messages are buffered by the engine anyway.
	conn:BindToMessage(function(message: any)
		if type(message) == "string" and alive then
			task.spawn(function()
				local ok, err = pcall(handleFrame, message)
				if not ok then
					softWarn("frame handling failed: " .. tostring(err))
				end
			end)
		end
	end)
	conn:GetPropertyChangedSignal("Connected"):Connect(function()
		if conn.Connected == false then
			stopRuntime()
			if announced then
				say("hub connection closed")
				announced = false
			end
		elseif not helloed and alive then
			-- The first hello was refused while the connection was still coming up.
			task.spawn(sendHello)
		end
	end)
	plugin.Unloading:Connect(function()
		alive = false
		stopRuntime()
	end)
	waitForLocalPlayer()
	sendHello()
end

task.spawn(function()
	local ok, err = pcall(if role == "edit" then editMain else playMain)
	if not ok then
		softWarn("bootstrap failed: " .. tostring(err))
	end
end)
