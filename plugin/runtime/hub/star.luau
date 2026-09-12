--[[
	PluginConnection star (§1.2, §3): the edit DM's side of every Test connection.

	Order matters: `.Connected` is connected FIRST, then existing connections are
	enumerated, so none is missed. Each peer does a hello handshake; dm names are
	"server" and "client:N" (N = join order within the current playtest).
	BindToMessage callbacks never yield: all work happens in task.spawn.

	Probes go only to connections that existed before this hub started (their bootstrap
	may have said hello to a previous hub); a freshly connected play DM hellos on its own.
	The bundle is pushed once per peer, and not at all when the peer already runs it.
]]

local protocol = require(script.Parent.Parent.shared.protocol)
local types = require(script.Parent.Parent.shared.types)
local util = require(script.Parent.Parent.shared.util)

type Bundle = types.Bundle

local Star = {}
Star.__index = Star

export type Peer = {
	conn: any,
	targetId: string,
	dm: string?,
	role: string?,
	userId: number?,
	playerName: string?,
	connected: boolean,
	bundleSent: boolean,
	assembler: protocol.Assembler,
	connections: { RBXScriptConnection },
	joinedAt: number,
}

export type Callbacks = {
	onEvent: (peer: Peer, frame: { [string]: any }) -> (),
	onResponse: (peer: Peer, frame: { [string]: any }) -> (),
	onPeer: (peer: Peer, connected: boolean) -> (),
	-- A later hello carried userId / playerName the first one lacked (client probed before LocalPlayer existed).
	onIdentity: (peer: Peer) -> (),
}

export type Star = typeof(setmetatable(
	{} :: {
		session: string,
		callbacks: Callbacks,
		bundleHash: string?,
		bundleChunks: { string },
		peers: { Peer },
		clientCount: number,
		connections: { RBXScriptConnection },
		warn: (string) -> (),
		service: PluginConnectionService?,
	},
	Star
))

function Star.new(session: string, bundle: Bundle?, callbacks: Callbacks): Star
	local chunks: { string } = {}
	local warnLimited = util.rateLimitedWarn(5)
	if bundle then
		local text = util.safeJsonEncode({ v = protocol.VERSION, kind = "bundle", hash = bundle.hash, entry = bundle.entry, modules = bundle.modules })
		local split = if text then protocol.chunkSplit(text, protocol.CHUNK_L2) else nil
		if split and #split == 1 and text then
			-- §3: bundle on L2 is always chunked, even when it would fit in one frame.
			split = protocol.chunkSplit(text, math.max(1024, math.floor(#text / 2)))
		end
		if split then
			chunks = split
		else
			warnLimited("runtime bundle could not be chunked; play DMs will not receive it")
		end
	end
	local ok, service = pcall(game.GetService, game, "PluginConnectionService")
	return setmetatable({
		session = session,
		callbacks = callbacks,
		bundleHash = if bundle then bundle.hash else nil,
		bundleChunks = chunks,
		peers = {},
		clientCount = 0,
		connections = {},
		warn = warnLimited,
		service = if ok then service :: PluginConnectionService else nil,
	}, Star)
end

function Star.available(self: Star): boolean
	return self.service ~= nil
end

function Star.sendText(self: Star, peer: Peer, text: string): boolean
	if not peer.connected then
		return false
	end
	local pieces = protocol.chunkSplit(text, protocol.CHUNK_L2)
	if pieces == nil then
		self.warn(("could not chunk a frame for %s"):format(peer.dm or peer.targetId))
		return false
	end
	for _, piece in ipairs(pieces) do
		local ok, err = pcall(peer.conn.SendMessage, peer.conn, piece)
		if not ok then
			self.warn(("send to %s failed: %s"):format(peer.dm or peer.targetId, tostring(err)))
			return false
		end
	end
	return true
end

function Star.send(self: Star, peer: Peer, frame: { [string]: any }): boolean
	local text = util.safeJsonEncode(frame)
	if text == nil then
		return false
	end
	return self:sendText(peer, text)
end

function Star.broadcast(self: Star, frame: { [string]: any })
	for _, peer in ipairs(self.peers) do
		if peer.connected and peer.dm then
			self:send(peer, frame)
		end
	end
end

-- dm: "server" | "client:N" | "client" (lowest-numbered connected client)
function Star.get(self: Star, dm: string): Peer?
	if dm == "client" then
		local best: Peer? = nil
		local bestN = math.huge
		for _, peer in ipairs(self.peers) do
			if peer.connected and peer.dm then
				local n = tonumber(string.match(peer.dm, "^client:(%d+)$"))
				if n and n < bestN then
					best, bestN = peer, n
				end
			end
		end
		return best
	end
	for _, peer in ipairs(self.peers) do
		if peer.connected and peer.dm == dm then
			return peer
		end
	end
	return nil
end

-- Connected client peers in join order.
function Star.clients(self: Star): { Peer }
	local out = {}
	for _, peer in ipairs(self.peers) do
		if peer.connected and peer.dm and string.match(peer.dm, "^client:%d+$") then
			table.insert(out, peer)
		end
	end
	return out
end

function Star.countClients(self: Star): number
	return #self:clients()
end

-- Peer list for `hb` / status.
function Star.list(self: Star): { { [string]: any } }
	local out = {}
	for _, peer in ipairs(self.peers) do
		if peer.dm then
			table.insert(out, { dm = peer.dm, connected = peer.connected, userId = peer.userId, playerName = peer.playerName })
		end
	end
	return out
end

function Star.hasConnectedPeers(self: Star): boolean
	for _, peer in ipairs(self.peers) do
		if peer.connected then
			return true
		end
	end
	return false
end

-- Restarts client numbering for a new test generation. Only safe while no client peer is connected
-- (a connected one keeps its number); returns whether the reset happened.
function Star.resetClientNumbering(self: Star): boolean
	if self:countClients() > 0 then
		return false
	end
	self.clientCount = 0
	return true
end

-- Re-checks a peer whose DM may be gone without the `Connected` signal having fired (a torn-down
-- server whose PluginConnection object lingers): detaches it when the connection reports itself
-- closed or refuses a frame. Returns whether the peer is still considered alive.
function Star.checkAlive(self: Star, peer: Peer): boolean
	if not peer.connected then
		return false
	end
	local okC, connected = pcall(function()
		return peer.conn.Connected
	end)
	if okC and connected == false then
		self:detach(peer)
		return false
	end
	-- Unknown kinds are ignored by contract (§ preamble), so a ping costs nothing on a live peer.
	if not self:send(peer, { v = protocol.VERSION, kind = "ping" }) then
		self:detach(peer)
		return false
	end
	return true
end

function Star.probe(self: Star, peer: Peer)
	-- The agent bootstrap answers a probe with hello even if it already sent one (§1.2 step 4).
	self:send(peer, { v = protocol.VERSION, kind = "probe" })
end

function Star.handleHello(self: Star, peer: Peer, frame: { [string]: any })
	if frame.proto ~= protocol.PROTO then
		self.warn(("peer %s has proto %s, expected %d"):format(peer.targetId, tostring(frame.proto), protocol.PROTO))
	end
	local first = peer.dm == nil
	if first then
		if frame.role == "server" then
			peer.dm = "server"
		else
			self.clientCount += 1
			peer.dm = ("client:%d"):format(self.clientCount)
		end
		peer.role = frame.role
	end
	local userId = if type(frame.userId) == "number" then frame.userId else nil
	local playerName = if type(frame.playerName) == "string" then frame.playerName else nil
	local identityChanged = (userId ~= nil and userId ~= peer.userId) or (playerName ~= nil and playerName ~= peer.playerName)
	if userId ~= nil then
		peer.userId = userId
	end
	if playerName ~= nil then
		peer.playerName = playerName
	end
	self:send(peer, { v = protocol.VERSION, kind = "hello_ack", proto = protocol.PROTO, dm = peer.dm, session = self.session, bundle = nil })
	local runsOurBundle = self.bundleHash ~= nil and frame.bundleHash == self.bundleHash
	if not peer.bundleSent and not runsOurBundle then
		peer.bundleSent = true
		for _, piece in ipairs(self.bundleChunks) do
			if not peer.connected then
				return
			end
			pcall(peer.conn.SendMessage, peer.conn, piece)
		end
	end
	if first then
		self.callbacks.onPeer(peer, true)
	elseif identityChanged then
		self.callbacks.onIdentity(peer)
	end
end

function Star.handleFrame(self: Star, peer: Peer, text: string)
	local frame = util.safeJsonDecode(text)
	if frame == nil then
		self.warn("undecodable frame from " .. (peer.dm or peer.targetId))
		return
	end
	local kind = frame.kind
	if kind == "chunk" then
		local whole = peer.assembler:feed(frame)
		if whole then
			self:handleFrame(peer, whole)
		end
	elseif kind == "hello" then
		self:handleHello(peer, frame)
	elseif kind == "ev" then
		if peer.dm then
			self.callbacks.onEvent(peer, frame)
		end
	elseif kind == "res" or kind == "progress" then
		if peer.dm then
			self.callbacks.onResponse(peer, frame)
		end
	end
	-- Unknown kinds are ignored by contract.
end

-- `probe` is true for connections that existed before this hub started.
function Star.attach(self: Star, conn: any, probe: boolean)
	for _, existing in ipairs(self.peers) do
		if existing.conn == conn then
			return
		end
	end
	local peer: Peer = {
		conn = conn,
		targetId = tostring(conn.TargetId),
		dm = nil,
		role = nil,
		userId = nil,
		playerName = nil,
		connected = conn.Connected == true,
		bundleSent = false,
		assembler = protocol.newAssembler(),
		connections = {},
		joinedAt = os.clock(),
	}
	table.insert(self.peers, peer)
	local okBind, bindConn = pcall(conn.BindToMessage, conn, function(message: any)
		if type(message) ~= "string" then
			return
		end
		task.spawn(function()
			local ok, err = pcall(self.handleFrame, self, peer, message)
			if not ok then
				self.warn("peer frame failed: " .. tostring(err))
			end
		end)
	end)
	if okBind then
		table.insert(peer.connections, bindConn)
	else
		self.warn("BindToMessage failed: " .. tostring(bindConn))
	end
	local okSig, sig = pcall(function()
		return conn:GetPropertyChangedSignal("Connected")
	end)
	if okSig then
		table.insert(
			peer.connections,
			sig:Connect(function()
				if conn.Connected == false then
					self:detach(peer)
				elseif not peer.connected then
					-- Enumerated (or announced) before the DM finished connecting: it is sendable now.
					peer.connected = true
					self:probe(peer)
				end
			end)
		)
	end
	if probe and peer.connected then
		self:probe(peer)
	end
end

function Star.detach(self: Star, peer: Peer)
	if not peer.connected then
		return
	end
	peer.connected = false
	for _, c in ipairs(peer.connections) do
		pcall(c.Disconnect, c)
	end
	peer.connections = {}
	if peer.dm then
		self.callbacks.onPeer(peer, false)
	end
	for i, p in ipairs(self.peers) do
		if p == peer then
			table.remove(self.peers, i)
			break
		end
	end
	if not self:hasConnectedPeers() then
		-- A finished playtest tears every Test connection down; the next one restarts numbering.
		self.clientCount = 0
	end
end

function Star.start(self: Star)
	local service = self.service
	if service == nil then
		self.warn("PluginConnectionService unavailable; play DMs cannot be reached")
		return
	end
	table.insert(
		self.connections,
		service.Connected:Connect(function(conn)
			if conn.Type == Enum.PluginConnectionTargetType.Test then
				self:attach(conn, false)
			end
		end)
	)
	local ok, existing = pcall(service.GetPluginConnectionsOfType, service, Enum.PluginConnectionTargetType.Test)
	if ok and type(existing) == "table" then
		for _, conn in ipairs(existing) do
			self:attach(conn, true)
		end
	end
end

function Star.stop(self: Star)
	for _, c in ipairs(self.connections) do
		pcall(c.Disconnect, c)
	end
	self.connections = {}
	for _, peer in ipairs(table.clone(self.peers)) do
		for _, c in ipairs(peer.connections) do
			pcall(c.Disconnect, c)
		end
		peer.connections = {}
		peer.connected = false
	end
	self.peers = {}
end

return Star
