--[[ studio-live skill
name: remote_map
description: Any DM: lists RemoteEvent, UnreliableRemoteEvent, RemoteFunction, BindableEvent and BindableFunction instances under ARGS.root (default: the whole DataModel minus Studio internals) with their paths, plus counts per class.
params: {"root":{"type":"string","default":"game"},"max":{"type":"integer","default":500,"maximum":5000,"description":"cap per class"},"classes":{"type":"array","items":{"type":"string"},"description":"subset of the classes to include"}}
]]
local DEFAULT_CLASSES = { "RemoteEvent", "UnreliableRemoteEvent", "RemoteFunction", "BindableEvent", "BindableFunction" }

local max = math.floor(math.clamp(tonumber(ARGS.max) or 500, 1, 5000))
local classes = if type(ARGS.classes) == "table" and #ARGS.classes > 0 then ARGS.classes else DEFAULT_CLASSES
local root: string? = nil
if type(ARGS.root) == "string" and ARGS.root ~= "" and ARGS.root ~= "game" then
	if S.get(ARGS.root) == nil then
		error(("no instance at root path '%s'"):format(ARGS.root), 0)
	end
	root = ARGS.root
end

local remotes = {}
local counts: { [string]: number } = {}
local truncated = false
local skipped = {}
for _, class in ipairs(classes) do
	local spec: { [string]: any } = { class = tostring(class), max = max }
	if root then
		spec.root = root
	end
	-- A class name this build does not know must not fail the whole map.
	local ok, list = pcall(S.find, spec)
	if not ok then
		table.insert(skipped, ("%s: %s"):format(tostring(class), tostring(list)))
	else
		counts[tostring(class)] = #list
		if #list >= max then
			truncated = true
		end
		for i, inst in ipairs(list) do
			table.insert(remotes, { path = S.path(inst), class = inst.ClassName, name = inst.Name })
			if i % 128 == 0 then
				S.yield()
			end
		end
	end
end
table.sort(remotes, function(a, b)
	return a.path < b.path
end)

return {
	dm = S.dm,
	root = root or "game",
	count = #remotes,
	counts = counts,
	truncated = truncated,
	skipped = skipped,
	remotes = remotes,
}
