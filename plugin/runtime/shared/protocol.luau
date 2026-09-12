--[[
	Wire-protocol constants and frame helpers (docs/protocol.md).
	Every frame that leaves a DM is built here so field names stay in one place.
]]

local util = require(script.Parent.util)

local protocol = {}

protocol.VERSION = 1
protocol.PROTO = 1

protocol.EVENT_MAX_BYTES = 4 * 1024 -- §2.5
protocol.CHUNK_L1 = 512 * 1024 -- §3
protocol.CHUNK_L2 = 16 * 1024 -- §3
protocol.OUTPUT_MAX_ENTRIES = 200 -- §4.1
protocol.OUTPUT_MAX_BYTES = 32 * 1024 -- §4.1
protocol.CONCISE_BYTES = 20 * 1024 -- §4.2
protocol.DETAILED_BYTES = 200 * 1024 -- §4.2
protocol.STRING_MAX = 8 * 1024 -- §7
protocol.UNACKED_RING = 2000 -- §2.6
protocol.HB_INTERVAL = 10 -- §2.7
protocol.PROGRESS_MIN_INTERVAL = 0.25 -- §2.3 (4/s)
protocol.DEFAULT_DEADLINE_MS = 30000

protocol.ERROR_CODES = {
	luau_error = true,
	syntax_error = true,
	timeout = true,
	no_peer = true,
	bad_request = true,
	cancelled = true,
	disconnected = true,
	busy = true,
	unsupported = true,
	internal = true,
	-- §4.1 geometry_policy "reject": the program ran but added overlapping / nested parts.
	geometry_violation = true,
}

-- Structured extras an error may carry besides stack / output (§2.2: "executors may attach more
-- fields"): the geometry report and warning lines of a `geometry_violation`, the change counts of
-- the rolled-back run and its `undo` outcome.
local ERROR_EXTRAS: { [string]: string } = { geometry = "table", changes = "table", warnings = "table", undo = "string" }

function protocol.res(id: string, dm: string, body: any): { [string]: any }
	return { v = protocol.VERSION, kind = "res", id = id, ok = true, dm = dm, body = body }
end

function protocol.err(id: string, dm: string, err: { [string]: any }): { [string]: any }
	local code = if protocol.ERROR_CODES[err.code] then err.code else "internal"
	local e: { [string]: any } = { code = code, message = util.truncate(tostring(err.message), 8192) }
	if type(err.stack) == "string" then
		e.stack = util.truncate(err.stack, 8192)
	end
	if type(err.output) == "table" then
		e.output = err.output
	end
	for key, expected in pairs(ERROR_EXTRAS) do
		if type(err[key]) == expected then
			e[key] = err[key]
		end
	end
	return { v = protocol.VERSION, kind = "res", id = id, ok = false, dm = dm, error = e }
end

function protocol.progress(id: string, note: string?, pct: number?): { [string]: any }
	local f: { [string]: any } = { v = protocol.VERSION, kind = "progress", id = id }
	if note then
		f.note = util.truncate(note, 512)
	end
	if pct then
		f.pct = util.clamp(pct, 0, 1)
	end
	return f
end

-- Truncates the free-text fields of an event until its JSON form fits EVENT_MAX_BYTES.
function protocol.capEvent(ev: { [string]: any }): string?
	local text = util.safeJsonEncode(ev)
	if text == nil then
		return nil
	end
	local fields = { "msg", "stack", "detail" }
	local budget = protocol.EVENT_MAX_BYTES
	local rounds = 0
	while #text > budget and rounds < 6 do
		rounds += 1
		local over = #text - budget
		local shrunk = false
		for _, f in ipairs(fields) do
			local v = ev[f]
			if type(v) == "string" and #v > 64 then
				local target = math.max(64, #v - over - 32)
				ev[f] = util.truncate(v, target)
				shrunk = true
				break
			end
		end
		if not shrunk then
			-- Nothing textual left to trim: drop the most likely offender.
			if ev.data ~= nil then
				ev.data = "<omitted: too large>"
			elseif ev.paths ~= nil then
				ev.paths = "<omitted: too large>"
			else
				break
			end
		end
		text = util.safeJsonEncode(ev)
		if text == nil then
			return nil
		end
	end
	if #text > budget then
		return nil
	end
	return text
end

-- Cuts `text` into pieces of at most `slice` bytes on UTF-8 character boundaries. JSON text is
-- ASCII outside strings, but string contents carry raw UTF-8 that must not be split.
function protocol.slices(text: string, slice: number): { string }
	local out = {}
	local pos = 1
	local n = #text
	while pos <= n do
		local cut = util.utf8Cut(text, math.min(n, pos + slice - 1))
		if cut < pos then
			-- Only continuation bytes fit (malformed input): take the raw slice rather than loop forever.
			cut = math.min(n, pos + slice - 1)
		end
		table.insert(out, string.sub(text, pos, cut))
		pos = cut + 1
	end
	if #out == 0 then
		out[1] = ""
	end
	return out
end

-- §3: splits an encoded frame into chunk frames when it exceeds `limit` bytes.
-- Returns nil when a piece cannot be encoded (a chunk that is not valid UTF-8 would silently
-- lose the whole frame on the receiving side, so the caller must treat nil as a send failure).
local chunkCounter = 0
function protocol.chunkSplit(text: string, limit: number): { string }?
	if #text <= limit then
		return { text }
	end
	chunkCounter += 1
	local cid = ("c-%d"):format(chunkCounter)
	-- Headroom for the envelope and JSON escaping; halve the slice if a piece still overflows.
	local slice = math.max(1024, math.floor(limit * 0.75))
	for _ = 1, 6 do
		local pieces = protocol.slices(text, slice)
		local n = #pieces
		local out = table.create(n)
		local overflow = false
		for i, piece in ipairs(pieces) do
			local encoded = util.safeJsonEncode({ v = protocol.VERSION, kind = "chunk", cid = cid, i = i - 1, n = n, data = piece })
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

-- Reassembles chunk frames; returns the completed text when the last piece arrives.
local Assembler = {}
Assembler.__index = Assembler
export type Assembler = typeof(setmetatable({} :: { pending: { [string]: any } }, Assembler))

function protocol.newAssembler(): Assembler
	return setmetatable({ pending = {} }, Assembler)
end

function Assembler.feed(self: Assembler, frame: { [string]: any }): string?
	local cid, i, n, data = frame.cid, frame.i, frame.n, frame.data
	if type(cid) ~= "string" or type(i) ~= "number" or type(n) ~= "number" or type(data) ~= "string" then
		return nil
	end
	if n < 1 or i < 0 or i >= n then
		return nil
	end
	local entry = self.pending[cid]
	if entry == nil then
		entry = { parts = {}, got = 0, n = n, at = os.clock() }
		self.pending[cid] = entry
		-- Bound memory: forget assemblies that never completed.
		for otherId, other in pairs(self.pending) do
			if os.clock() - other.at > 120 then
				self.pending[otherId] = nil
			end
		end
	end
	if entry.parts[i + 1] == nil then
		entry.got += 1
	end
	entry.parts[i + 1] = data
	if entry.got >= entry.n then
		self.pending[cid] = nil
		return table.concat(entry.parts)
	end
	return nil
end

return protocol
