--[[
	Log journal (`observe logs`) and the LogService / ScriptContext sources that feed
	`log` and `error` events. Hub and agent both use it; only the seq assignment differs
	(the hub's emit returns the global event seq, the agent's its local aseq).
]]

local LogService = game:GetService("LogService")
local ScriptContext = game:GetService("ScriptContext")

local paths = require(script.Parent.paths)
local Ring = require(script.Parent.ring)
local util = require(script.Parent.util)

local Logs = {}
Logs.__index = Logs

local LEVELS: { [Enum.MessageType]: string } = {
	[Enum.MessageType.MessageOutput] = "print",
	[Enum.MessageType.MessageInfo] = "info",
	[Enum.MessageType.MessageWarning] = "warn",
	[Enum.MessageType.MessageError] = "error",
}

local INTERNAL_PREFIX = "[StudioLive]"
local MSG_MAX = 2048

export type Logs = typeof(setmetatable(
	{} :: { ring: Ring.Ring, connections: { RBXScriptConnection }, src: string },
	Logs
))

function Logs.new(src: string, capacity: number?): Logs
	return setmetatable({ ring = Ring.new(capacity or 2000), connections = {}, src = src }, Logs)
end

-- Records a line that already has a seq (from the emitter) into the journal.
function Logs.record(self: Logs, entry: { [string]: any })
	self.ring:push(entry)
end

export type SeedOptions = {
	-- Only history lines stamped at or after this wall-clock second are kept (default: this Studio process).
	sinceWall: number?,
	-- When given, every kept line is emitted as a `log` event with `history = true` (so it gets a real
	-- seq and reaches the hub / bridge journals) instead of being stored locally with seq 0.
	emit: ((ev: { [string]: any }) -> number)?,
}

-- Seeds the journal from LogService history. Without `opts.emit` the lines carry seq 0 (protocol
-- Notes: returned only for since ≤ 0, never pushed as events); play-DM agents pass `emit` so their
-- startup output is paged like any other line (F4). Returns the number of lines seeded.
function Logs.seedHistory(self: Logs, maxEntries: number?, opts: SeedOptions?): number
	local ok, history = pcall(LogService.GetLogHistory, LogService)
	if not ok or type(history) ~= "table" then
		return 0
	end
	local since = if opts and type(opts.sinceWall) == "number" then opts.sinceWall else os.time() - os.clock() - 2
	local keep = {}
	for i = #history, 1, -1 do
		local h = history[i]
		if type(h) == "table" and type(h.timestamp) == "number" and h.timestamp >= since then
			table.insert(keep, 1, h)
			if #keep >= (maxEntries or 200) then
				break
			end
		end
	end
	local emit = if opts then opts.emit else nil
	local n = 0
	for _, h in ipairs(keep) do
		local msg = tostring(h.message)
		if string.sub(msg, 1, #INTERNAL_PREFIX) ~= INTERNAL_PREFIX then
			local level = LEVELS[h.messageType] or "print"
			local text = util.truncate(util.utf8Safe(msg), MSG_MAX)
			if emit then
				pcall(emit, { type = "log", level = level, msg = text, wall = h.timestamp, history = true })
			else
				self.ring:push({ seq = 0, t = 0, wall = h.timestamp, level = level, msg = text, src = self.src, seeded = true })
			end
			n += 1
		end
	end
	return n
end

-- True when a line with the same level and text and a wall-clock stamp within 2 s is already in
-- the journal (last `window` entries, default 400), optionally only among lines from `src`. The hub
-- uses it to drop history lines a play *client* re-sends for output the server already produced: in
-- a Play test LogService mirrors server prints into the client's history, so the client's seed would
-- repeat the server's. Restricting the match to `src = "server"` keeps identical repeats from one DM
-- (`print("coin spawned")` twenty times at start) and lets a client's own line through.
function Logs.hasSimilar(self: Logs, ev: { [string]: any }, window: number?, src: string?): boolean
	local msg = ev.msg
	if type(msg) ~= "string" then
		return false
	end
	local wall = if type(ev.wall) == "number" then ev.wall else nil
	local count = self.ring:size()
	local first = math.max(1, count - (window or 400) + 1)
	for i = count, first, -1 do
		local item = self.ring:at(i)
		if item ~= nil and item.msg == msg and item.level == ev.level and (src == nil or item.src == src) then
			if wall == nil or type(item.wall) ~= "number" or math.abs(item.wall - wall) <= 2 then
				return true
			end
		end
	end
	return false
end

-- Connects LogService.MessageOut and ScriptContext.Error to `emit`.
function Logs.attach(self: Logs, emit: (ev: { [string]: any }) -> number)
	table.insert(
		self.connections,
		LogService.MessageOut:Connect(function(message: string, messageType: Enum.MessageType)
			if string.sub(message, 1, #INTERNAL_PREFIX) == INTERNAL_PREFIX then
				return
			end
			-- Never yield or error here; emit is expected to be non-yielding.
			pcall(emit, {
				type = "log",
				level = LEVELS[messageType] or "print",
				msg = util.truncate(util.utf8Safe(message), MSG_MAX),
			})
		end)
	)
	table.insert(
		self.connections,
		ScriptContext.Error:Connect(function(message: string, stack: string, script: Instance?)
			pcall(emit, {
				type = "error",
				msg = util.truncate(util.utf8Safe(message), MSG_MAX),
				stack = util.truncate(util.utf8Safe(stack or ""), MSG_MAX),
				script = if script then paths.of(script) else nil,
			})
		end)
	)
end

function Logs.detach(self: Logs)
	for _, c in ipairs(self.connections) do
		c:Disconnect()
	end
	self.connections = {}
end

-- `observe logs` query. Returns { items, next }. `dm = "all"` (or none) returns every DM's lines;
-- each item carries `src`.
function Logs.query(self: Logs, body: { [string]: any }): { [string]: any }
	local since = util.num(body.since, -1)
	local tail = math.floor(util.num(body.tail, 100, 1, 1000))
	local level = if type(body.level) == "string" then body.level else nil
	local filter = if type(body.filter) == "string" and body.filter ~= "" then string.lower(body.filter) else nil
	local dm = if type(body.dm) == "string" and body.dm ~= "" and body.dm ~= "all" then body.dm else nil
	local function pred(item: { [string]: any }): boolean
		if since >= 0 and (item.seq or 0) <= since and not (since == 0 and item.seeded) then
			return false
		end
		if level and item.level ~= level then
			return false
		end
		if dm and item.src ~= dm then
			return false
		end
		if filter and not string.find(string.lower(item.msg or ""), filter, 1, true) then
			return false
		end
		return true
	end
	local items = self.ring:tail(tail, pred)
	local out = table.create(#items)
	local nextSeq = math.max(since, 0)
	for i, item in ipairs(items) do
		out[i] = { seq = item.seq, t = item.t, level = item.level, msg = item.msg, src = item.src, script = item.script, history = if item.history then true else nil }
		if type(item.seq) == "number" and item.seq > nextSeq then
			nextSeq = item.seq
		end
	end
	return { items = out, next = nextSeq }
end

return Logs
