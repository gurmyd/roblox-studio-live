--[[
	L1 framing over the bootstrap's WebSocket Link: JSON encode/decode and the
	512 KB outbound chunk split (§3). Inbound chunks are already reassembled by the
	bootstrap, so frames arriving here are always whole.

	Responses and progress frames produced while the socket is down (the bootstrap's
	scheduled refresh, a transient drop) are queued and flushed by `relinked()`, because
	the bridge keeps the matching job alive across the reconnect.
]]

local protocol = require(script.Parent.Parent.shared.protocol)
local types = require(script.Parent.Parent.shared.types)
local util = require(script.Parent.Parent.shared.util)

type RawLink = types.Link

local Link = {}

local QUEUE_MAX = 200

export type Link = {
	send: (frame: { [string]: any }) -> boolean,
	sendText: (text: string) -> boolean,
	-- Like send, but a frame the socket cannot take right now is kept for the next relink.
	-- Returns false only when the frame cannot be encoded at all.
	sendOrQueue: (frame: { [string]: any }) -> boolean,
	flushQueued: () -> number,
	onFrame: (fn: (frame: { [string]: any }, text: string) -> ()) -> () -> (),
	isOpen: () -> boolean,
	stats: () -> { [string]: any },
}

function Link.new(raw: RawLink): Link
	local warnLimited = util.rateLimitedWarn(5)
	local encodeFailures = 0
	local queued: { string } = {}

	local function sendText(text: string): boolean
		if not raw.isOpen() then
			return false
		end
		local pieces = protocol.chunkSplit(text, protocol.CHUNK_L1)
		if pieces == nil then
			encodeFailures += 1
			warnLimited("could not chunk an outbound frame")
			return false
		end
		local ok = true
		for _, piece in ipairs(pieces) do
			if not raw.send(piece) then
				ok = false
			end
		end
		return ok
	end

	local function send(frame: { [string]: any }): boolean
		local text = util.safeJsonEncode(frame)
		if text == nil then
			encodeFailures += 1
			warnLimited("could not encode frame kind=" .. tostring(frame.kind))
			return false
		end
		return sendText(text)
	end

	local function sendOrQueue(frame: { [string]: any }): boolean
		local text = util.safeJsonEncode(frame)
		if text == nil then
			encodeFailures += 1
			warnLimited("could not encode frame kind=" .. tostring(frame.kind))
			return false
		end
		if sendText(text) then
			return true
		end
		table.insert(queued, text)
		if #queued > QUEUE_MAX then
			table.remove(queued, 1)
		end
		return true
	end

	local function flushQueued(): number
		local pending = queued
		queued = {}
		local n = 0
		for _, text in ipairs(pending) do
			if sendText(text) then
				n += 1
			else
				table.insert(queued, text)
			end
		end
		return n
	end

	local function onFrame(fn: (frame: { [string]: any }, text: string) -> ()): () -> ()
		return raw.onFrame(function(text: string, decoded: { [string]: any }?)
			local frame = decoded or util.safeJsonDecode(text)
			if frame == nil then
				warnLimited("dropped undecodable frame from bridge")
				return
			end
			fn(frame, text)
		end)
	end

	return {
		send = send,
		sendText = sendText,
		sendOrQueue = sendOrQueue,
		flushQueued = flushQueued,
		onFrame = onFrame,
		isOpen = raw.isOpen,
		stats = function()
			local s = raw.stats()
			s.encodeFailures = encodeFailures
			s.queued = #queued
			return s
		end,
	}
end

return Link
