--[[
	Hub event pipeline (§2.5–§2.7): stamps `seq`, retains unacked events in a ring of
	2000, re-sends after relinked(), handles acks and emits heartbeats.
]]

local protocol = require(script.Parent.Parent.shared.protocol)
local Ring = require(script.Parent.Parent.shared.ring)
local util = require(script.Parent.Parent.shared.util)

local Link = require(script.Parent.link)

type FramedLink = Link.Link

local Events = {}

export type Events = {
	emit: (ev: { [string]: any }) -> number,
	ack: (upto: number) -> (),
	resend: (ackUpto: number?) -> number,
	hb: (peers: { any }, playtest: { [string]: any }, fps: number, placeName: string?, extra: { [string]: any }?) -> (),
	lastSeq: () -> number,
	unacked: () -> number,
	dropped: () -> number,
	-- After stop() nothing is emitted or sent: a replaced runtime's leftover threads must not stamp
	-- seqs that collide with its successor's (the bootstrap starts the next runtime at lastSeq()).
	stop: () -> (),
}

function Events.new(link: FramedLink, lastSeq: number, ackUpto: number, logs: any): Events
	local seq = math.max(0, math.floor(lastSeq))
	local ring = Ring.new(protocol.UNACKED_RING)
	local warnLimited = util.rateLimitedWarn(5)
	local droppedTotal = 0
	local stopped = false

	local function ack(upto: number)
		ring:dropWhile(function(item)
			return item.seq <= upto
		end)
	end

	local function emit(ev: { [string]: any }): number
		if stopped then
			return seq
		end
		seq += 1
		ev.v = protocol.VERSION
		ev.kind = "ev"
		ev.seq = seq
		ev.t = ev.t or os.clock()
		ev.wall = ev.wall or os.time()
		ev.src = ev.src or "edit"
		local text = protocol.capEvent(ev)
		if text == nil then
			-- Keep the seq contiguous even when the payload cannot be encoded.
			text = protocol.capEvent({ v = 1, kind = "ev", seq = seq, t = ev.t, wall = ev.wall, src = ev.src, type = ev.type or "custom", msg = "<unencodable event>" })
				or ""
		end
		if (ev.type == "log" or ev.type == "error") and logs then
			logs:record({ seq = seq, t = ev.t, wall = ev.wall, level = ev.level or "error", msg = ev.msg, src = ev.src, script = ev.script, history = ev.history })
		end
		ring:push({ seq = seq, text = text })
		if link.isOpen() and not link.sendText(text) then
			warnLimited("event send failed")
		end
		return seq
	end

	local function resend(upto: number?): number
		if upto then
			ack(upto)
		end
		local n = 0
		for _, item in ipairs(ring:collect()) do
			if link.sendText(item.text) then
				n += 1
			end
		end
		return n
	end

	-- `placeName` (the resolved place name, once known) lets the bridge replace the hello's game.Name;
	-- `extra` carries further identity fields (universeId, creatorType, creatorId) the hello cannot.
	local function hb(peers: { any }, playtest: { [string]: any }, fps: number, placeName: string?, extra: { [string]: any }?)
		if stopped then
			return
		end
		local dropped = ring:takeDropped()
		droppedTotal += dropped
		local frame: { [string]: any } = {
			v = protocol.VERSION,
			kind = "hb",
			seq = seq,
			t = os.clock(),
			peers = peers,
			playtest = playtest,
			dropped = dropped,
			fps = util.round(fps, 1),
			placeName = placeName,
		}
		if extra then
			for k, v in pairs(extra) do
				if frame[k] == nil then
					frame[k] = v
				end
			end
		end
		link.send(frame)
	end

	if ackUpto > 0 then
		ack(ackUpto)
	end

	return {
		emit = emit,
		ack = ack,
		resend = resend,
		hb = hb,
		lastSeq = function()
			return seq
		end,
		unacked = function()
			return ring:size()
		end,
		dropped = function()
			return droppedTotal + ring.dropped
		end,
		stop = function()
			stopped = true
		end,
	}
end

return Events
