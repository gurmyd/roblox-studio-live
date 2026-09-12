--[[
	Bundle entry (protocol.md §1): start(ctx) picks the hub (edit DM) or the agent
	(play DMs) and returns the runtime table the bootstrap drives.
]]

local types = require(script.Parent.shared.types)

type Ctx = types.Ctx
type Runtime = types.Runtime

local runtime = {}

function runtime.start(ctx: Ctx): Runtime
	if type(ctx) ~= "table" or type(ctx.link) ~= "table" then
		error("runtime.start: ctx.link is required", 0)
	end
	if ctx.role == "edit" then
		return require(script.Parent.hub.init).start(ctx)
	elseif ctx.role == "server" or ctx.role == "client" then
		return require(script.Parent.agent.init).start(ctx)
	end
	error(("runtime.start: unknown role '%s'"):format(tostring(ctx.role)), 0)
end

return runtime
