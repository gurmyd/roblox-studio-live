--[[ studio-live skill
name: bulk_attributes
description: Sets and/or clears attributes on every instance matched by ARGS.find (an S.find spec: root, name, class, tag, attr, max). Values are JSON scalars or {"$v3":[x,y,z]}, {"$v2":[x,y]}, {"$color":"#rrggbb"}; ARGS.dry lists the matches without writing. Edit DM: one undo step.
params: {"find":{"type":"object","properties":{"root":{"type":"string"},"name":{"type":"string"},"class":{"type":"string"},"tag":{"type":"string"},"attr":{"type":"object","properties":{"name":{"type":"string"},"value":{}}},"max":{"type":"integer","default":500}},"description":"S.find spec selecting the targets (required)"},"set":{"type":"object","description":"attribute name -> value to set"},"clear":{"type":"array","items":{"type":"string"},"description":"attribute names to remove"},"dry":{"type":"boolean","default":false}}
]]
local spec = ARGS.find
if type(spec) ~= "table" then
	error("ARGS.find (an S.find spec: {root, name, class, tag, attr, max}) is required", 0)
end
local set = if type(ARGS.set) == "table" then ARGS.set else {}
local clear = if type(ARGS.clear) == "table" then ARGS.clear else {}
local dry = ARGS.dry == true
if next(set) == nil and #clear == 0 and not dry then
	error("nothing to do: pass ARGS.set and/or ARGS.clear (or dry=true to preview the matches)", 0)
end

-- JSON cannot carry Roblox types; a one-key table names the type to build.
local function decodeValue(v: any): any
	if type(v) ~= "table" then
		return v
	end
	if type(v["$v3"]) == "table" then
		local t = v["$v3"]
		return Vector3.new(tonumber(t[1]) or 0, tonumber(t[2]) or 0, tonumber(t[3]) or 0)
	elseif type(v["$v2"]) == "table" then
		local t = v["$v2"]
		return Vector2.new(tonumber(t[1]) or 0, tonumber(t[2]) or 0)
	elseif type(v["$color"]) == "string" then
		return Color3.fromHex(v["$color"])
	end
	error("attribute values must be JSON scalars or {\"$v3\"|\"$v2\"|\"$color\": …}", 0)
end

local decoded: { [string]: any } = {}
for name, v in pairs(set) do
	decoded[tostring(name)] = decodeValue(v)
end

local findSpec = table.clone(spec)
findSpec.max = math.floor(tonumber(spec.max) or 500)
local targets = S.find(findSpec)

local updated, cleared = 0, 0
local errors = {}
local sample = {}
for i, inst in ipairs(targets) do
	if i <= 20 then
		table.insert(sample, S.path(inst))
	end
	if not dry then
		for name, value in pairs(decoded) do
			local ok, err = pcall(inst.SetAttribute, inst, name, value)
			if ok then
				updated += 1
			elseif #errors < 20 then
				table.insert(errors, ("%s.%s: %s"):format(S.path(inst), name, tostring(err)))
			end
		end
		for _, name in ipairs(clear) do
			local ok, err = pcall(inst.SetAttribute, inst, tostring(name), nil)
			if ok then
				cleared += 1
			elseif #errors < 20 then
				table.insert(errors, ("%s.%s: %s"):format(S.path(inst), tostring(name), tostring(err)))
			end
		end
	end
	if i % 64 == 0 then
		S.yield()
	end
end

return {
	matched = #targets,
	truncated = #targets >= findSpec.max,
	dry = dry,
	updated = updated,
	cleared = cleared,
	errors = errors,
	sample = sample,
}
