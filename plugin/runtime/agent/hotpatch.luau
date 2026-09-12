--[[
	`playtest hotpatch` (§4.3): write a script's Source in the live DM and restart it
	by toggling Disabled. Verified: a hot-injected script runs on the next frame.
]]

local paths = require(script.Parent.Parent.shared.paths)
local util = require(script.Parent.Parent.shared.util)

local hotpatch = {}

function hotpatch.apply(body: { [string]: any }): { [string]: any }
	if type(body.path) ~= "string" then
		error(util.perr("bad_request", "hotpatch: 'path' is required"), 0)
	end
	if type(body.source) ~= "string" then
		error(util.perr("bad_request", "hotpatch: 'source' must be a string"), 0)
	end
	local inst = paths.resolve(body.path)
	if inst == nil then
		error(util.perr("bad_request", ("hotpatch: no instance at '%s'"):format(body.path)), 0)
	end
	if not inst:IsA("LuaSourceContainer") then
		error(util.perr("bad_request", ("hotpatch: %s is a %s, not a script"):format(body.path, inst.ClassName)), 0)
	end
	local ok, err = pcall(function()
		(inst :: any).Source = body.source
	end)
	if not ok then
		error(util.perr("internal", ("hotpatch: cannot write Source: %s"):format(tostring(err))), 0)
	end
	local result: { [string]: any } = { patched = paths.of(inst), class = inst.ClassName, restarted = false }
	if inst:IsA("ModuleScript") then
		result.note = "require cache unaffected; re-require a clone"
		return result
	end
	if body.restart ~= false and inst:IsA("BaseScript") then
		local bs = inst :: BaseScript
		bs.Disabled = true
		task.wait()
		bs.Disabled = false
		result.restarted = true
	end
	return result
end

return hotpatch
