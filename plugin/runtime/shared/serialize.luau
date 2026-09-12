--[[
	Luau value → JSON-safe value, per protocol.md §7.
]]

local paths = require(script.Parent.paths)
local protocol = require(script.Parent.protocol)
local util = require(script.Parent.util)

local serialize = {}

export type Options = { detailed: boolean?, maxDepth: number?, maxKeys: number?, maxString: number? }

local function num(n: number): any
	if n ~= n then
		return "nan"
	elseif n == math.huge then
		return "inf"
	elseif n == -math.huge then
		return "-inf"
	end
	return n
end

local function v3(v: Vector3): { number }
	return { num(v.X), num(v.Y), num(v.Z) }
end

local function colorHex(c: Color3): string
	return ("#%02x%02x%02x"):format(
		math.floor(util.clamp(c.R, 0, 1) * 255 + 0.5),
		math.floor(util.clamp(c.G, 0, 1) * 255 + 0.5),
		math.floor(util.clamp(c.B, 0, 1) * 255 + 0.5)
	)
end

local function cframe(cf: CFrame, detailed: boolean): { [string]: any }
	local out: { [string]: any } = { p = v3(cf.Position), look = v3(cf.LookVector) }
	if detailed then
		local comps = { cf:GetComponents() }
		for i, c in ipairs(comps) do
			comps[i] = num(c)
		end
		out.c = comps
	end
	return out
end

local function walk(value: any, depth: number, opts: Options, stack: { [any]: boolean }): any
	local t = typeof(value)
	if t == "nil" or t == "boolean" then
		return value
	elseif t == "number" then
		return num(value)
	elseif t == "string" then
		local s = util.utf8Safe(value)
		local max = opts.maxString or protocol.STRING_MAX
		if #s > max then
			local keep = util.utf8Cut(s, max)
			return string.sub(s, 1, keep) .. ("…[+%d]"):format(#s - keep)
		end
		return s
	elseif t == "table" then
		if stack[value] then
			return "<cycle>"
		end
		if depth > (opts.maxDepth or 6) then
			return "<depth>"
		end
		stack[value] = true
		local maxKeys = opts.maxKeys or 500
		local out: any
		if util.isArray(value) then
			out = {}
			local n = #value
			for i = 1, math.min(n, maxKeys) do
				out[i] = walk(value[i], depth + 1, opts, stack)
			end
			if n > maxKeys then
				table.insert(out, ("…[+%d more]"):format(n - maxKeys))
			end
		else
			out = {}
			local count = 0
			local total = 0
			for k, v in pairs(value) do
				total += 1
				if count < maxKeys then
					local key = if type(k) == "string" then k else tostring(k)
					out[key] = walk(v, depth + 1, opts, stack)
					count += 1
				end
			end
			if total > maxKeys then
				out["…"] = ("[+%d more]"):format(total - maxKeys)
			end
		end
		stack[value] = nil
		return out
	elseif t == "Instance" then
		return { ["$i"] = paths.of(value), class = value.ClassName }
	elseif t == "Vector3" then
		return v3(value)
	elseif t == "Vector2" then
		return { num(value.X), num(value.Y) }
	elseif t == "CFrame" then
		return cframe(value, opts.detailed == true)
	elseif t == "Color3" then
		return colorHex(value)
	elseif t == "EnumItem" then
		return tostring(value)
	elseif t == "BrickColor" then
		return value.Name
	elseif t == "UDim2" then
		return { num(value.X.Scale), num(value.X.Offset), num(value.Y.Scale), num(value.Y.Offset) }
	elseif t == "UDim" then
		return { num(value.Scale), num(value.Offset) }
	elseif t == "buffer" then
		return { ["$buf"] = buffer.len(value) }
	elseif t == "function" then
		return "<function>"
	elseif t == "thread" then
		return "<thread>"
	elseif t == "RaycastResult" then
		return {
			Instance = walk(value.Instance, depth + 1, opts, stack),
			Position = v3(value.Position),
			Normal = v3(value.Normal),
			Material = tostring(value.Material),
			Distance = num(value.Distance),
		}
	elseif t == "NumberRange" then
		return { num(value.Min), num(value.Max) }
	elseif t == "Rect" then
		return { num(value.Min.X), num(value.Min.Y), num(value.Max.X), num(value.Max.Y) }
	elseif t == "Vector3int16" or t == "Vector2int16" then
		return tostring(value)
	end
	-- Everything else (Ray, Region3, TweenInfo, DateTime, Font, …) keeps its tostring form.
	local ok, s = pcall(tostring, value)
	return if ok then s else "<" .. t .. ">"
end

function serialize.value(value: any, opts: Options?): any
	return walk(value, 1, opts or {}, {})
end

-- Encodes a value to JSON text; falls back to a tostring form if encoding fails.
function serialize.json(value: any, opts: Options?): string
	local safe = serialize.value(value, opts)
	return util.safeJsonEncode(safe) or util.safeJsonEncode(tostring(safe)) or "null"
end

serialize.colorHex = colorHex

return serialize
