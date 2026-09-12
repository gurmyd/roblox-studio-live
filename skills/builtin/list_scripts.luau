--[[ studio-live skill
name: list_scripts
description: Any DM: lists every Script/LocalScript/ModuleScript under ARGS.root (default: the whole DataModel minus Studio internals) with class, Source length and an FNV-1a 32-bit checksum of Source (hex), so two DMs or two moments can be compared without shipping sources.
params: {"root":{"type":"string","default":"game"},"max":{"type":"integer","default":500,"maximum":5000},"name":{"type":"string","description":"case-insensitive name substring filter"},"with_source":{"type":"boolean","default":false,"description":"include the first 200 chars of each Source"}}
]]
local max = math.floor(math.clamp(tonumber(ARGS.max) or 500, 1, 5000))
local withSource = ARGS.with_source == true

-- FNV-1a 32-bit; the multiply is split so it never exceeds double precision.
local function fnv1a32(s: string): string
	local h = 2166136261
	for i = 1, #s do
		h = bit32.bxor(h, string.byte(s, i))
		local lo = h % 65536
		local hi = (h - lo) / 65536
		h = (lo * 16777619 + ((hi * 16777619) % 65536) * 65536) % 4294967296
	end
	return string.format("%08x", h)
end

local spec: { [string]: any } = { class = "LuaSourceContainer", max = max }
if type(ARGS.root) == "string" and ARGS.root ~= "" and ARGS.root ~= "game" then
	if S.get(ARGS.root) == nil then
		error(("no instance at root path '%s'"):format(ARGS.root), 0)
	end
	spec.root = ARGS.root
end
if type(ARGS.name) == "string" and ARGS.name ~= "" then
	spec.name = ARGS.name
end
local list = S.find(spec)

local scripts = {}
local unreadable = 0
for i, inst in ipairs(list) do
	local okSrc, source = pcall(function()
		return (inst :: any).Source
	end)
	local entry: { [string]: any } = { path = S.path(inst), class = inst.ClassName }
	if okSrc and type(source) == "string" then
		entry.len = #source
		entry.hash = fnv1a32(source)
		if withSource then
			entry.head = string.sub(source, 1, 200)
		end
	else
		unreadable += 1
		entry.unreadable = true
	end
	if inst:IsA("BaseScript") then
		entry.enabled = not (inst :: BaseScript).Disabled
	end
	if inst:IsA("Script") then
		entry.runContext = (inst :: Script).RunContext.Name
	end
	table.insert(scripts, entry)
	S.yield()
end

return {
	dm = S.dm,
	root = spec.root or "game",
	count = #scripts,
	truncated = #list >= max,
	unreadable = unreadable,
	hash = "fnv1a32",
	scripts = scripts,
}
