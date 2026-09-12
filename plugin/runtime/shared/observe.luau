--[[
	`observe` implementations shared by hub and agent (protocol.md §4.2).
	Role-specific `what`s (status / selection / player) are supplied by the caller.
]]

local Players = game:GetService("Players")
local Stats = game:GetService("Stats")
local Workspace = game:GetService("Workspace")

local geometry = require(script.Parent.geometry)
local paths = require(script.Parent.paths)
local protocol = require(script.Parent.protocol)
local query = require(script.Parent.query)
local serialize = require(script.Parent.serialize)
local types = require(script.Parent.types)
local util = require(script.Parent.util)

type Env = types.Env

local observe = {}

local function isDetailed(body: { [string]: any }): boolean
	return body.format == "detailed" or body.response_format == "detailed"
end

-- Shrinks list-valued fields until the encoded result fits the format cap. A `next` cursor
-- (observe logs) is moved back to the last item still present so nothing is skipped.
function observe.cap(result: { [string]: any }, body: { [string]: any }): { [string]: any }
	local budget = if isDetailed(body) then protocol.DETAILED_BYTES else protocol.CONCISE_BYTES
	for _ = 1, 8 do
		local text = util.safeJsonEncode(result)
		if text ~= nil and #text <= budget then
			return result
		end
		local shrunk = false
		for _, key in ipairs({ "nodes", "items", "added", "removed", "paths", "overlaps", "nested" }) do
			local list = result[key]
			if type(list) == "table" and #list > 1 then
				local keep = math.max(1, math.floor(#list / 2))
				for i = #list, keep + 1, -1 do
					list[i] = nil
				end
				shrunk = true
			end
		end
		result.truncated = true
		if type(result.next) == "number" and type(result.items) == "table" then
			local last = result.items[#result.items]
			if type(last) == "table" and type(last.seq) == "number" then
				result.next = last.seq
			end
		end
		if not shrunk then
			break
		end
	end
	return result
end

function observe.tree(body: { [string]: any }): { [string]: any }
	local root = if body.root == nil or body.root == "game" then game else paths.resolve(body.root)
	if root == nil then
		error(util.perr("bad_request", ("tree: no instance at '%s'"):format(tostring(body.root))), 0)
	end
	return query.tree(root, util.num(body.depth, 2, 0, 6), {
		max = body.max,
		classes = body.classes,
		fields = body.fields,
		detailed = isDetailed(body),
	})
end

function observe.props(body: { [string]: any }): { [string]: any }
	local list = body.paths
	if type(list) ~= "table" then
		error(util.perr("bad_request", "props: 'paths' must be an array"), 0)
	end
	local names = if type(body.props) == "table" and #body.props > 0 then body.props else nil
	local items, missing = {}, {}
	for i, p in ipairs(list) do
		if i > 200 then
			break
		end
		local inst = if type(p) == "string" then paths.resolve(p) else nil
		if inst then
			table.insert(items, query.props(inst, names, isDetailed(body)))
		else
			table.insert(missing, tostring(p))
		end
	end
	return { items = items, missing = missing }
end

function observe.find(body: { [string]: any }): { [string]: any }
	local spec: query.FindSpec = {
		root = body.root,
		name = body.name,
		class = body.class,
		tag = body.tag,
		attr = body.attr,
		prop = body.prop,
		max = body.max,
	}
	if body.root ~= nil and paths.resolve(body.root) == nil then
		error(util.perr("bad_request", ("find: no instance at '%s'"):format(tostring(body.root))), 0)
	end
	local list, total = query.find(spec)
	local items = table.create(#list)
	for i, inst in ipairs(list) do
		items[i] = { path = paths.of(inst), class = inst.ClassName, name = inst.Name }
	end
	return { items = items, total = total }
end

function observe.diff(body: { [string]: any }, env: Env): { [string]: any }
	return env.journal:diff(math.floor(util.num(body.since, 0, 0)))
end

function observe.logs(body: { [string]: any }, env: Env): { [string]: any }
	return env.logs:query(body)
end

-- Line budget for `observe script` text: the format cap minus room for the envelope.
local SCRIPT_TEXT_MARGIN = 1024

-- `observe script` {path, from?, to?}: the source (edit DM: the live editor buffer) as whole lines,
-- exempt from the §7 8 KB string cap up to the response format budget (concise ≈ 20 KB,
-- detailed ≈ 200 KB). When the range does not fit, `to` is pulled back to the last whole line that
-- does, `truncated = true` and `next_from` says where to continue.
function observe.script(body: { [string]: any }, env: Env): { [string]: any }
	local path = body.path
	if type(path) ~= "string" or path == "" then
		error(util.perr("bad_request", "script: 'path' is required"), 0)
	end
	local inst = paths.resolve(path)
	if inst == nil then
		error(util.perr("bad_request", ("script: no instance at '%s'"):format(path)), 0)
	end
	if not inst:IsA("LuaSourceContainer") then
		error(util.perr("bad_request", ("script: %s is a %s, not a script"):format(path, inst.ClassName)), 0)
	end
	local source: string? = nil
	if env.scriptSource then
		source = env.scriptSource(inst :: LuaSourceContainer)
	end
	if source == nil then
		local ok, s = pcall(function()
			return (inst :: any).Source
		end)
		if not ok or type(s) ~= "string" then
			error(util.perr("internal", ("script: cannot read the Source of %s: %s"):format(path, tostring(s))), 0)
		end
		source = s
	end
	local text, total, from, to = util.sliceLines(source :: string, body.from, body.to)
	local budget = (if isDetailed(body) then protocol.DETAILED_BYTES else protocol.CONCISE_BYTES) - SCRIPT_TEXT_MARGIN
	local truncated = false
	local cutLine = false
	local result: { [string]: any } = { path = paths.of(inst), class = inst.ClassName, from = from, to = to, lines = math.max(0, to - from + 1), total_lines = total, text = text }
	for _ = 1, 12 do
		local encoded = util.safeJsonEncode(result)
		if encoded ~= nil and #encoded <= budget + SCRIPT_TEXT_MARGIN then
			break
		end
		if to <= from then
			-- A single line that does not fit is cut on a character boundary instead of dropped. Whole-line
			-- paging cannot continue past it: next_from stays at this line and the note says how to read it.
			result.text = util.truncate(result.text, budget)
			truncated = true
			cutLine = true
			break
		end
		-- Drop lines proportionally to the overshoot, at least one.
		local over = if encoded then #encoded - budget else #result.text
		local avg = math.max(1, #result.text / math.max(1, to - from + 1))
		local drop = math.max(1, math.ceil(over / avg))
		to = math.max(from, to - drop)
		truncated = true
		result.text = (util.sliceLines(source :: string, from, to))
		result.to = to
		result.lines = to - from + 1
	end
	if truncated then
		result.truncated = true
		result.next_from = if cutLine then from else result.to + 1
		if cutLine then
			result.line_cut = true
			result.note = ("line %d alone exceeds the %s budget; request it with response_format 'detailed' or read it in pieces with S.script.get(path, {from = %d, to = %d}) and string.sub"):format(
				from,
				if isDetailed(body) then "detailed" else "concise",
				from,
				from
			)
		end
	end
	return result
end

-- `observe geometry` {root?, max?, tolerance?, include_nested?} (§4.2): every BasePart under `root`
-- (default Workspace; Terrain never) checked for overlaps against the whole Workspace and for
-- BaseParts parented under BaseParts. `max` caps the parts checked (default 5000; a larger tree is
-- sampled with a stride and flagged `sampled`). Parts outside Workspace get the nesting check only.
function observe.geometry(body: { [string]: any }): { [string]: any }
	local root: Instance? = if body.root == nil or body.root == "Workspace" or body.root == "workspace" then Workspace else paths.resolve(body.root)
	if root == nil then
		error(util.perr("bad_request", ("geometry: no instance at '%s'"):format(tostring(body.root))), 0)
	end
	local maxParts = math.floor(util.num(body.max, geometry.MAX_PARTS, 1, geometry.MAX_PARTS))
	local parts, overflow = geometry.collect(root :: Instance, geometry.COLLECT_MAX)
	local report = geometry.report(parts, {
		tolerance = body.tolerance,
		maxParts = maxParts,
		budget = geometry.OBSERVE_BUDGET_S,
		include_nested = body.include_nested ~= false,
		partial = overflow,
	})
	local result: { [string]: any } = {
		root = paths.of(root :: Instance),
		parts = #parts,
		overlaps = report.overlaps,
		nested = report.nested,
		checked = report.checked,
		sampled = report.sampled,
		ms = report.ms,
		totals = report.totals,
	}
	if report.outside > 0 then
		result.outside = report.outside
		result.note = ("%d part%s outside Workspace were checked for nesting only (engine spatial queries cover Workspace)"):format(report.outside, if report.outside == 1 then "" else "s")
	end
	return result
end

local function statNumber(name: string): number?
	local ok, v = pcall(function()
		return (Stats :: any)[name]
	end)
	if ok and type(v) == "number" then
		return v
	end
	return nil
end

function observe.stats(env: Env): { [string]: any }
	local fps = env.fps()
	local okMem, mem = pcall(Stats.GetTotalMemoryUsageMb, Stats)
	-- Stats time properties are reported in seconds.
	local function ms(v: number?): number?
		return if v then util.round(v * 1000, 2) else nil
	end
	return {
		fps = util.round(fps, 1),
		frameMs = ms(statNumber("FrameTime")),
		heartbeatMs = ms(statNumber("HeartbeatTime")),
		physicsMs = ms(statNumber("PhysicsStepTime")),
		instances = statNumber("InstanceCount"),
		memoryMB = if okMem then util.round(mem, 1) else nil,
		drawCalls = statNumber("SceneDrawcallCount"),
	}
end

-- `observe player` / ctx.state(): snapshot of the local player (client DM only).
function observe.player(env: Env): { [string]: any }
	if env.role ~= "client" then
		error(util.perr("unsupported", "player snapshot is only available on client DMs (dm='client:N')"), 0)
	end
	local lp = Players.LocalPlayer
	if lp == nil then
		error(util.perr("internal", "no LocalPlayer yet"), 0)
	end
	local char = lp.Character
	local root = if char then char:FindFirstChild("HumanoidRootPart") else nil
	local humanoid = if char then char:FindFirstChildOfClass("Humanoid") else nil
	local camera = workspace.CurrentCamera
	local snap: { [string]: any } = {
		name = lp.Name,
		userId = lp.UserId,
		position = if root and root:IsA("BasePart") then serialize.value(root.Position) else nil,
		velocity = if root and root:IsA("BasePart") then serialize.value(root.AssemblyLinearVelocity) else nil,
		state = if humanoid then humanoid:GetState().Name else "NoCharacter",
		health = if humanoid then util.round(humanoid.Health, 2) else nil,
		walkSpeed = if humanoid then humanoid.WalkSpeed else nil,
		cameraCFrame = if camera then serialize.value(camera.CFrame) else nil,
		floorMaterial = if humanoid then tostring(humanoid.FloorMaterial) else nil,
		seated = if humanoid then humanoid.Sit or humanoid.SeatPart ~= nil else false,
	}
	return snap
end

export type Extra = { [string]: (body: { [string]: any }) -> { [string]: any } }

-- Dispatches `body.what`; `extra` supplies role-specific handlers (status, selection, player).
function observe.handle(body: { [string]: any }, env: Env, extra: Extra): { [string]: any }
	local what = body.what
	if type(what) ~= "string" then
		error(util.perr("bad_request", "observe: 'what' is required"), 0)
	end
	local result: { [string]: any }
	if extra[what] then
		result = extra[what](body)
	elseif what == "tree" then
		result = observe.tree(body)
	elseif what == "props" then
		result = observe.props(body)
	elseif what == "find" then
		result = observe.find(body)
	elseif what == "diff" then
		result = observe.diff(body, env)
	elseif what == "logs" then
		result = observe.logs(body, env)
	elseif what == "stats" then
		result = observe.stats(env)
	elseif what == "script" then
		-- Sized to the format budget by itself; observe.cap below only shrinks lists.
		return observe.script(body, env)
	elseif what == "player" then
		result = observe.player(env)
	elseif what == "geometry" then
		result = observe.geometry(body)
	elseif what == "screenshot" then
		error(util.perr("unsupported", "screenshot is captured by the bridge, not Studio"), 0)
	else
		error(util.perr("bad_request", ("observe: unknown what '%s'"):format(what)), 0)
	end
	return observe.cap(result, body)
end

return observe
