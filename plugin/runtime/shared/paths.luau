--[[
	Dotted instance paths.

	Accepted forms: `game.Workspace.X`, `Workspace.X`, `workspace.X`, GetFullName()
	output, and bracket segments for names containing dots: `Workspace["a.b"].Child`.
	Produced form (paths.of): segments joined by "." with bracket-quoting whenever a
	name contains ".", "[", "]" or a quote, so every produced path resolves again.
]]

local paths = {}

local SERVICE_ALIASES: { [string]: string } = {
	workspace = "Workspace",
	Workspace = "Workspace",
	game = "game",
}

-- Splits a path into segments, honouring ["..."] / ['...'] quoting.
function paths.parse(path: string): { string }
	local out = {}
	local i = 1
	local n = #path
	local current = ""
	while i <= n do
		local c = string.sub(path, i, i)
		if c == "." then
			if current ~= "" then
				table.insert(out, current)
			end
			current = ""
			i += 1
		elseif c == "[" then
			if current ~= "" then
				table.insert(out, current)
				current = ""
			end
			local q = string.sub(path, i + 1, i + 1)
			if q == '"' or q == "'" then
				local close = string.find(path, q .. "]", i + 2, true)
				if close == nil then
					table.insert(out, string.sub(path, i + 2))
					return out
				end
				table.insert(out, string.sub(path, i + 2, close - 1))
				i = close + 2
			else
				local close = string.find(path, "]", i + 1, true)
				if close == nil then
					table.insert(out, string.sub(path, i + 1))
					return out
				end
				table.insert(out, string.sub(path, i + 1, close - 1))
				i = close + 1
			end
		else
			current ..= c
			i += 1
		end
	end
	if current ~= "" then
		table.insert(out, current)
	end
	return out
end

local function childNamed(parent: Instance, name: string): Instance?
	local child = parent:FindFirstChild(name)
	if child then
		return child
	end
	if parent == game then
		local ok, svc = pcall(game.GetService, game, name)
		if ok and typeof(svc) == "Instance" then
			return svc
		end
	end
	return nil
end

-- Resolves `path` starting from `root` (default: the DataModel).
function paths.resolve(path: string, root: Instance?): Instance?
	if type(path) ~= "string" then
		return nil
	end
	local segs = paths.parse(path)
	local node: Instance = root or game
	local start = 1
	if root == nil and segs[1] ~= nil then
		local alias = SERVICE_ALIASES[segs[1]]
		if alias == "game" then
			start = 2
		elseif alias ~= nil then
			node = game:GetService("Workspace")
			start = 2
		end
	end
	for i = start, #segs do
		local nxt = childNamed(node, segs[i])
		if nxt == nil then
			return nil
		end
		node = nxt
	end
	return node
end

local function quoteSegment(name: string): string
	if string.find(name, "[%.%[%]\"']") then
		return ('["%s"]'):format((string.gsub(name, '"', '\\"')))
	end
	return name
end

-- Joins name segments (top-level first) the way paths.of does, quoting where needed.
function paths.join(names: { string }): string
	local parts = table.create(#names)
	for i, name in ipairs(names) do
		parts[i] = quoteSegment(name)
	end
	local s = table.concat(parts, ".")
	-- Bracketed segments must not be preceded by a dot ("Workspace["a.b"]").
	return (string.gsub(s, "%.%[", "["))
end

-- Path of an instance relative to the DataModel ("game" for the DataModel itself).
function paths.of(inst: Instance): string
	if inst == game then
		return "game"
	end
	local names = {}
	local node: Instance? = inst
	while node ~= nil and node ~= game do
		table.insert(names, 1, node.Name)
		node = node.Parent
	end
	return paths.join(names)
end

-- Accepts an Instance, a path string, or nil; returns the instance or nil + reason.
function paths.toInstance(v: any, root: Instance?): (Instance?, string?)
	if typeof(v) == "Instance" then
		return v, nil
	elseif type(v) == "string" then
		local inst = paths.resolve(v, root)
		if inst == nil then
			return nil, ("no instance at path '%s'"):format(v)
		end
		return inst, nil
	end
	return nil, ("expected Instance or path, got %s"):format(typeof(v))
end

return paths
