--[[
	Small dependency-free helpers used by every runtime module.
]]

local HttpService = game:GetService("HttpService")

local util = {}

-- Largest byte offset ≤ `to` at which `s` can be cut without splitting a UTF-8 sequence
-- (backs up over continuation bytes 0x80–0xBF so the byte after the cut starts a character).
function util.utf8Cut(s: string, to: number): number
	local n = #s
	if to >= n then
		return n
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

-- Truncates `s` to at most `max` bytes on a character boundary, appending the protocol's
-- "…[+N chars]" marker. Invalid UTF-8 is escaped first so the result always encodes as JSON.
function util.truncate(s: string, max: number): string
	if #s > max then
		s = util.utf8Safe(s)
	end
	if #s <= max then
		return s
	end
	local keep = util.utf8Cut(s, math.max(0, max - 24))
	return string.sub(s, 1, keep) .. ("…[+%d chars]"):format(#s - keep)
end

function util.clamp(n: number, lo: number, hi: number): number
	if n < lo then
		return lo
	elseif n > hi then
		return hi
	end
	return n
end

-- Reads a numeric field with a default and optional bounds; non-numbers fall back to the default.
function util.num(v: any, default: number, lo: number?, hi: number?): number
	local n = if type(v) == "number" and v == v then v else default
	if lo then
		n = math.max(lo, n)
	end
	if hi then
		n = math.min(hi, n)
	end
	return n
end

function util.safeJsonEncode(value: any): string?
	local ok, text = pcall(HttpService.JSONEncode, HttpService, value)
	if ok and type(text) == "string" then
		return text
	end
	return nil
end

function util.safeJsonDecode(text: string): { [string]: any }?
	local ok, value = pcall(HttpService.JSONDecode, HttpService, text)
	if ok and type(value) == "table" then
		return value
	end
	return nil
end

-- Roblox strings may contain invalid UTF-8 (binary data, terrain); JSONEncode rejects those.
function util.utf8Safe(s: string): string
	if utf8.len(s) ~= nil then
		return s
	end
	return (string.gsub(s, "[\128-\255]", function(c)
		return ("\\x%02x"):format(string.byte(c))
	end))
end

function util.formatArgs(...: any): string
	local n = select("#", ...)
	local parts = table.create(n)
	for i = 1, n do
		parts[i] = tostring((select(i, ...)))
	end
	return table.concat(parts, " ")
end

-- Returns a rate-limited warn function: at most one message per `interval` seconds.
function util.rateLimitedWarn(interval: number): (string) -> ()
	local last = -math.huge
	local suppressed = 0
	return function(msg: string)
		local now = os.clock()
		if now - last < interval then
			suppressed += 1
			return
		end
		last = now
		if suppressed > 0 then
			msg = msg .. (" (+%d suppressed)"):format(suppressed)
			suppressed = 0
		end
		warn("[StudioLive] " .. msg)
	end
end

function util.isArray(t: { [any]: any }): boolean
	local n = #t
	if n == 0 then
		return next(t) == nil
	end
	for k in pairs(t) do
		if type(k) ~= "number" or k < 1 or k > n or k % 1 ~= 0 then
			return false
		end
	end
	return true
end

function util.round(n: number, places: number?): number
	local m = 10 ^ (places or 3)
	return math.floor(n * m + 0.5) / m
end

-- Lines `from`..`to` (1-based, inclusive; defaults 1 and the last line) of `source`, joined with
-- "\n". Returns the text, the total line count and the clamped range actually returned
-- (`to < from` yields "" with to = from - 1). CRLF sources keep their "\r" on each line.
function util.sliceLines(source: string, from: any?, to: any?): (string, number, number, number)
	local lines = string.split(source, "\n")
	local total = #lines
	local a = math.floor(util.num(from, 1, 1))
	local b = math.floor(util.num(to, total, 0))
	if a > total then
		return "", total, a, a - 1
	end
	if b > total then
		b = total
	end
	if b < a then
		return "", total, a, a - 1
	end
	return table.concat(lines, "\n", a, b), total, a, b
end

-- Builds an error object that the dispatcher turns into a protocol error response.
function util.perr(code: string, message: string, extra: { [string]: any }?): { [string]: any }
	local e = { code = code, message = message }
	if extra then
		for k, v in pairs(extra) do
			e[k] = v
		end
	end
	return e
end

-- Normalises any thrown value into a ProtocolError-shaped table.
function util.toProtocolError(err: any, defaultCode: string?): { [string]: any }
	if type(err) == "table" and type(err.code) == "string" then
		if type(err.message) ~= "string" then
			err.message = tostring(err.message)
		end
		return err
	end
	return { code = defaultCode or "internal", message = tostring(err) }
end

return util
