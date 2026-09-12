--[[
	Instance queries shared by `observe` and the S API: find, tree, props.
	Luau has no property reflection, so "all interesting props" is a curated list per class.
]]

local CollectionService = game:GetService("CollectionService")

local paths = require(script.Parent.paths)
local serialize = require(script.Parent.serialize)
local util = require(script.Parent.util)

local query = {}

-- Ordered: earlier entries are more general; every matching class contributes its props.
local DEFAULT_PROPS: { { string | { string } } } = {
	{ "BasePart", { "Position", "Orientation", "Size", "Anchored", "CanCollide", "Transparency", "Color", "Material" } },
	{ "Part", { "Shape" } },
	{ "MeshPart", { "MeshId", "TextureID" } },
	{ "Model", { "PrimaryPart", "WorldPivot" } },
	{ "Attachment", { "WorldPosition", "CFrame" } },
	{ "Humanoid", { "Health", "MaxHealth", "WalkSpeed", "JumpPower", "HipHeight", "DisplayName" } },
	{ "BaseScript", { "Enabled" } },
	{ "Script", { "RunContext" } },
	{ "GuiObject", { "AbsolutePosition", "AbsoluteSize", "Position", "Size", "AnchorPoint", "Visible", "ZIndex", "BackgroundColor3", "BackgroundTransparency" } },
	{ "TextLabel", { "Text", "TextColor3", "TextSize" } },
	{ "TextButton", { "Text", "TextColor3", "TextSize" } },
	{ "TextBox", { "Text", "PlaceholderText" } },
	{ "ImageLabel", { "Image" } },
	{ "ImageButton", { "Image" } },
	{ "ScreenGui", { "Enabled", "DisplayOrder", "IgnoreGuiInset" } },
	{ "Light", { "Brightness", "Color", "Enabled", "Range" } },
	{ "Camera", { "CFrame", "FieldOfView", "CameraType" } },
	{ "Sound", { "SoundId", "Playing", "Volume", "Looped" } },
	{ "ValueBase", { "Value" } },
	{ "Player", { "UserId", "DisplayName", "Team" } },
	{ "Seat", { "Occupant" } },
	{ "ProximityPrompt", { "ActionText", "ObjectText", "Enabled" } },
	{ "Tool", { "Enabled", "RequiresHandle" } },
	{ "Constraint", { "Enabled", "Attachment0", "Attachment1" } },
	{ "Terrain", { "WaterLevel" } },
}

local MAX_DEFAULT_PROPS = 60

function query.defaultProps(inst: Instance): { string }
	local out = { "Name" }
	for _, entry in ipairs(DEFAULT_PROPS) do
		local class = entry[1] :: string
		if inst:IsA(class) then
			for _, p in ipairs(entry[2] :: { string }) do
				if #out >= MAX_DEFAULT_PROPS then
					return out
				end
				table.insert(out, p)
			end
		end
	end
	return out
end

-- Reads named properties (pcall each); adds Attributes / Tags when present.
function query.props(inst: Instance, names: { string }?, detailed: boolean?): { [string]: any }
	local list = names or query.defaultProps(inst)
	local props: { [string]: any } = {}
	local opts = { detailed = detailed, maxDepth = 3, maxString = if detailed then 8192 else 512 }
	for _, name in ipairs(list) do
		if type(name) == "string" then
			local ok, v = pcall(function()
				return (inst :: any)[name]
			end)
			-- A property the class lacks (or cannot expose) is omitted rather than reported as a placeholder.
			if ok then
				props[name] = if name == "Parent" and typeof(v) == "Instance" then paths.of(v) else serialize.value(v, opts)
			end
		end
	end
	if names == nil then
		local okA, attrs = pcall(inst.GetAttributes, inst)
		if okA and next(attrs) ~= nil then
			props.Attributes = serialize.value(attrs, opts)
		end
		local okT, tags = pcall(CollectionService.GetTags, CollectionService, inst)
		if okT and #tags > 0 then
			props.Tags = tags
		end
	end
	return { path = paths.of(inst), class = inst.ClassName, props = props }
end

export type FindSpec = {
	root: any?,
	name: string?,
	class: string?,
	tag: string?,
	attr: { name: string, value: any? }?,
	prop: { name: string, value: any }?,
	max: number?,
}

local function valuesEqual(a: any, b: any): boolean
	if a == b then
		return true
	end
	if typeof(a) == "EnumItem" then
		return tostring(a) == b or a.Name == b
	end
	return tostring(a) == tostring(b)
end

-- Studio-internal trees a whole-DataModel search never means (protocol Notes); an explicit root still reaches them.
local FIND_SKIP_SERVICES: { [string]: boolean } = {
	Stats = true,
	CoreGui = true,
	CorePackages = true,
	PluginGuiService = true,
	PluginDebugService = true,
	RobloxPluginGuiService = true,
	StudioService = true,
}

local function underSkippedService(inst: Instance): boolean
	local node = inst
	while node.Parent ~= nil and node.Parent ~= game do
		node = node.Parent :: Instance
	end
	return node.Parent == game and FIND_SKIP_SERVICES[node.ClassName] == true
end

local function matches(inst: Instance, spec: FindSpec, nameLower: string?): boolean
	if spec.class and not inst:IsA(spec.class) then
		return false
	end
	if nameLower and not string.find(string.lower(inst.Name), nameLower, 1, true) then
		return false
	end
	if spec.attr then
		local ok, v = pcall(inst.GetAttribute, inst, spec.attr.name)
		if not ok or v == nil then
			return false
		end
		if spec.attr.value ~= nil and not valuesEqual(v, spec.attr.value) then
			return false
		end
	end
	if spec.prop then
		local ok, v = pcall(function()
			return (inst :: any)[spec.prop.name]
		end)
		if not ok or not valuesEqual(v, spec.prop.value) then
			return false
		end
	end
	return true
end

-- Returns matching instances (≤ max) and the total number of matches.
function query.find(spec: FindSpec): ({ Instance }, number)
	local root = if spec.root == nil then game else paths.toInstance(spec.root)
	if root == nil then
		return {}, 0
	end
	local max = math.floor(util.num(spec.max, 100, 1, 5000))
	local nameLower = if type(spec.name) == "string" and spec.name ~= "" then string.lower(spec.name) else nil
	local candidates: { Instance }
	if type(spec.tag) == "string" then
		candidates = {}
		for _, inst in ipairs(CollectionService:GetTagged(spec.tag)) do
			if (inst == root or inst:IsDescendantOf(root)) and not (root == game and underSkippedService(inst)) then
				table.insert(candidates, inst)
			end
		end
	elseif root == game then
		candidates = {}
		for _, service in ipairs(game:GetChildren()) do
			if not FIND_SKIP_SERVICES[service.ClassName] then
				table.insert(candidates, service)
				-- A service whose children the plugin may not enumerate must not fail the whole search.
				local ok, descendants = pcall(service.GetDescendants, service)
				if ok then
					table.move(descendants, 1, #descendants, #candidates + 1, candidates)
				end
			end
		end
	else
		candidates = root:GetDescendants()
	end
	local out = {}
	local total = 0
	for _, inst in ipairs(candidates) do
		if matches(inst, spec, nameLower) then
			total += 1
			if #out < max then
				table.insert(out, inst)
			end
		end
	end
	return out, total
end

export type TreeOptions = { max: number?, classes: { string }?, fields: { string }?, detailed: boolean? }

local function isEmptyService(inst: Instance): boolean
	return inst.Parent == game and #inst:GetChildren() == 0
end

-- Breadth-first tree of `root` down to `depth` levels.
function query.tree(root: Instance, depth: number, opts: TreeOptions): { [string]: any }
	local max = math.floor(util.num(opts.max, 500, 1, 20000))
	depth = math.floor(util.num(depth, 2, 0, 6))
	local classes = if type(opts.classes) == "table" and #opts.classes > 0 then opts.classes else nil
	local fields = if type(opts.fields) == "table" and #opts.fields > 0 then opts.fields else nil
	local nodes = {}
	local truncated = false
	local queue: { { inst: Instance, level: number } } = {}
	if root == game then
		for _, child in ipairs(game:GetChildren()) do
			table.insert(queue, { inst = child, level = 1 })
		end
	else
		table.insert(queue, { inst = root, level = 0 })
	end
	local head = 1
	while head <= #queue do
		local item = queue[head]
		head += 1
		local inst = item.inst
		-- Empty services are omitted from a whole-DataModel tree; an explicit root (level 0) is
		-- always returned, with n = 0 when it has no descendants, and the class filter applies to
		-- its descendants only (F9).
		local skip = item.level > 0 and inst.Parent == game and isEmptyService(inst)
		if not skip and classes and item.level > 0 then
			skip = true
			for _, c in ipairs(classes) do
				if inst:IsA(c) then
					skip = false
					break
				end
			end
		end
		if not skip then
			if #nodes >= max then
				truncated = true
				break
			end
			local node: { [string]: any } = {
				path = paths.of(inst),
				class = inst.ClassName,
				name = inst.Name,
				n = #inst:GetDescendants(),
			}
			if fields then
				node.props = query.props(inst, fields, opts.detailed).props
			end
			table.insert(nodes, node)
		end
		if item.level < depth then
			for _, child in ipairs(inst:GetChildren()) do
				table.insert(queue, { inst = child, level = item.level + 1 })
			end
		end
	end
	return { nodes = nodes, truncated = truncated }
end

return query
