--[[
	Agent-side event emitter: sends `ev` frames to the hub without `seq` (the hub
	stamps it, §2.5); `aseq` is the agent's local counter, also used as the cursor
	for the agent's own `observe logs` journal.
]]

local protocol = require(script.Parent.Parent.shared.protocol)
local types = require(script.Parent.Parent.shared.types)
local util = require(script.Parent.Parent.shared.util)

type Link = types.Link

local Events = {}

export type Events = { emit: (ev: { [string]: any }) -> number, lastSeq: () -> number }

-- `startSeq` (the previous runtime's aseq after a bundle swap) keeps the agent's cursor monotonic.
function Events.new(link: Link, dm: string, logs: any, startSeq: number?): Events
	local aseq = math.max(0, math.floor(startSeq or 0))
	local warnLimited = util.rateLimitedWarn(5)

	local function emit(ev: { [string]: any }): number
		aseq += 1
		ev.v = protocol.VERSION
		ev.kind = "ev"
		ev.aseq = aseq
		ev.t = ev.t or os.clock()
		ev.wall = ev.wall or os.time()
		ev.src = ev.src or dm
		local text = protocol.capEvent(ev)
		if text == nil then
			text = protocol.capEvent({ v = 1, kind = "ev", aseq = aseq, t = ev.t, wall = ev.wall, src = dm, type = ev.type, msg = "<unencodable event>" })
		end
		if (ev.type == "log" or ev.type == "error") and logs then
			logs:record({ seq = aseq, t = ev.t, wall = ev.wall, level = ev.level or "error", msg = ev.msg, src = dm, script = ev.script, history = ev.history })
		end
		if text ~= nil and link.isOpen() then
			if not link.send(text) then
				warnLimited("event send failed")
			end
		end
		return aseq
	end

	return {
		emit = emit,
		lastSeq = function()
			return aseq
		end,
	}
end

return Events
