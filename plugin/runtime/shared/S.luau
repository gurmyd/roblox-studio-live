--[[
	The resident `S` API (protocol.md §6). One instance per program / controller so
	S.yield() and S.wait() observe that request's cancellation.
	Helpers that only make sense on another DM return nil, "wrong_dm".
]]

local CollectionService = game:GetService("CollectionService")
local PathfindingService = game:GetService("PathfindingService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local StarterGui = game:GetService("StarterGui")
local Workspace = game:GetService("Workspace")

local geometry = require(script.Parent.geometry)
local paths = require(script.Parent.paths)
local query = require(script.Parent.query)
local serialize = require(script.Parent.serialize)
local types = require(script.Parent.types)
local util = require(script.Parent.util)

type Control = types.Control

local S = {}

export type SEnv = {
	role: string,
	dm: string,
	emit: (ev: { [string]: any }) -> number,
	scriptEditor: ((script: LuaSourceContainer, source: string) -> (boolean, string?))?,
	-- Edit DM: the live editor buffer (ScriptEditorService:GetEditorSource), nil when unavailable.
	scriptSource: ((script: LuaSourceContainer) -> string?)?,
}

local SLICE_BUDGET = 0.008
-- Entries kept in S.unwritable per program (each is one property the plugin VM could not write).
local UNWRITABLE_MAX = 100
-- Instances remembered in S.touched per program (the geometry check's own cap).
local TOUCHED_MAX = 5000
-- Property writes that move or resize a part, so the run's geometry check must look at it again.
local GEOMETRY_PROPS: { [string]: boolean } = { CFrame = true, Position = true, Size = true, Orientation = true, Rotation = true, PivotOffset = true }
-- pathTo: a waypoint counts as reached within this horizontal distance (waypoints are ~4 studs apart).
local WAYPOINT_REACH = 2.5
-- pathTo: no progress towards the current waypoint for this long → jump once, then recompute.
local STUCK_S = 1.5
local PATH_RECOMPUTES = 3

local function fail(fmt: string, ...: any)
	error(fmt:format(...), 0)
end

local function resolveOrError(target: any, what: string): Instance
	local inst, why = paths.toInstance(target)
	if inst == nil then
		fail("%s: %s", what, why or "unresolved")
	end
	return inst :: Instance
end

-- Engine-gated properties (F8): the plugin VM cannot read or write some members (Lighting.Technology
-- → "lacking capability RobloxScript"; Workspace.SignalBehavior → "not a valid member"). Those are
-- collected instead of thrown; every other failure (a bad value, a locked instance) still throws.
local function isCapabilityError(msg: string): boolean
	return string.find(msg, "lacking capability", 1, true) ~= nil or string.find(msg, "not a valid member", 1, true) ~= nil
end

local function toPosition(v: any, what: string): Vector3
	if typeof(v) == "Vector3" then
		return v
	elseif typeof(v) == "CFrame" then
		return v.Position
	elseif typeof(v) == "Instance" or type(v) == "string" then
		local inst = resolveOrError(v, what)
		if inst:IsA("BasePart") then
			return inst.Position
		elseif inst:IsA("Model") then
			return inst:GetPivot().Position
		elseif inst:IsA("Attachment") then
			return inst.WorldPosition
		end
		fail("%s: %s has no position", what, paths.of(inst))
	end
	fail("%s: expected Vector3, CFrame or Instance", what)
	return Vector3.zero
end

function S.new(env: SEnv, ctl: Control?): { [string]: any }
	local api: { [string]: any } = {}
	api.role = env.role
	api.dm = env.dm
	api.clock = os.clock
	-- Properties the plugin VM refused to write ({path, prop, reason}); the run response reports them.
	api.unwritable = {}
	-- Edit DM: instances S.destroy detached (Parent = nil) this program, referenced until the
	-- ChangeHistory recording is finished so Cancel / Undo can put them back.
	api.detached = {}
	-- BaseParts / Models this program moved, resized or re-parented through S (S.set / S.batchSet /
	-- S.placeOn / S.snapToGrid / S.grid and the PlaceOn prop): the run's geometry check (§4.1) covers
	-- them next to the parts the program added, so a pre-existing deck pushed into a wall is reported
	-- too. runner.run empties the set when the program starts. Direct writes (`part.CFrame = …`) are
	-- not seen here; `observe geometry` audits those. Weak keys: a controller's S lives for a whole
	-- playtest and must not pin instances the game has since destroyed.
	api.touched = setmetatable({}, { __mode = "k" })
	api.touchedCount = 0
	local function touch(inst: Instance)
		if api.touchedCount >= TOUCHED_MAX or api.touched[inst] then
			return
		end
		if inst:IsA("BasePart") or inst:IsA("Model") then
			api.touched[inst] = true
			api.touchedCount += 1
		end
	end

	-- `PlaceOn = target` / `PlaceOn = { target, align = "center", gap = 0 }` in a props table: rests the
	-- instance on the target (S.placeOn) once every other property, Size and CFrame included, is applied.
	local function applyPlaceOn(inst: Instance, spec: any, what: string)
		local target, align, gap = spec, nil, nil
		if type(spec) == "table" then
			target = spec[1] or spec.target or spec.on
			align = spec.align
			gap = spec.gap
		end
		local base = resolveOrError(target, what .. " PlaceOn")
		local ok, why = geometry.placeOn(inst, base, align, gap)
		if not ok then
			fail("%s PlaceOn: %s", what, tostring(why))
		end
		touch(inst)
	end

	-- Applies a props table; Attributes / Tags are expanded, PlaceOn then Parent are applied last.
	local function applyProps(inst: Instance, props: { [string]: any })
		local parent = nil
		local placeOn = nil
		for k, v in pairs(props) do
			if k == "Parent" then
				parent = v
			elseif k == "PlaceOn" then
				placeOn = v
			elseif k == "Attributes" and type(v) == "table" then
				for name, value in pairs(v) do
					local ok, err = pcall(inst.SetAttribute, inst, name, value)
					if not ok then
						fail("S.set: attribute %s on %s: %s", tostring(name), paths.of(inst), tostring(err))
					end
				end
			elseif k == "Tags" and type(v) == "table" then
				for _, tag in ipairs(v) do
					CollectionService:AddTag(inst, tostring(tag))
				end
			else
				local ok, err = pcall(function()
					(inst :: any)[k] = v
				end)
				if not ok then
					local msg = tostring(err)
					if isCapabilityError(msg) then
						if #api.unwritable < UNWRITABLE_MAX then
							table.insert(api.unwritable, { path = paths.of(inst), prop = tostring(k), reason = util.truncate(msg, 256) })
						end
					else
						fail("S.set: cannot set %s.%s: %s", paths.of(inst), tostring(k), msg)
					end
				elseif GEOMETRY_PROPS[k] then
					touch(inst)
				end
			end
		end
		if placeOn ~= nil then
			applyPlaceOn(inst, placeOn, "S.set")
		end
		if parent ~= nil then
			inst.Parent = resolveOrError(parent, "S.set Parent")
			touch(inst)
		end
	end

	-- §6.5 — the slice starts where the dispatcher's launch burst of this frame started (several queued
	-- writes launched in one frame share the 8 ms), not at this program's own launch.
	local sliceStart = if ctl and type(ctl.sliceStart) == "number" then ctl.sliceStart :: number else os.clock()
	function api.yield()
		if ctl then
			ctl.checkCancel()
		end
		if os.clock() - sliceStart > SLICE_BUDGET then
			task.wait()
			sliceStart = os.clock()
		end
	end
	function api.wait(seconds: number?)
		local deadline = os.clock() + math.max(0, tonumber(seconds) or 0)
		repeat
			if ctl then
				ctl.checkCancel()
			end
			task.wait(math.min(0.1, math.max(0, deadline - os.clock())))
		until os.clock() >= deadline
		sliceStart = os.clock()
	end
	-- Seconds left before the request's deadline (math.huge outside a request, e.g. controllers), so
	-- long programs can size their work instead of being cut off and rolled back.
	function api.remaining(): number
		if ctl then
			return ctl.remaining()
		end
		return math.huge
	end
	function api.json(value: any): string
		return serialize.json(value)
	end
	function api.emit(name: string, data: any?)
		env.emit({ type = "custom", name = tostring(name), data = serialize.value(data, { maxDepth = 4 }) })
	end
	function api.log(...: any)
		env.emit({ type = "log", level = "info", msg = util.truncate(util.formatArgs(...), 2048) })
	end

	-- §6.1 query
	function api.get(path: any): Instance?
		if typeof(path) == "Instance" then
			return path
		end
		return paths.resolve(path)
	end
	api.path = paths.of
	function api.find(spec: query.FindSpec?): { Instance }
		local list = query.find(spec or {})
		return list
	end
	function api.tree(inst: any?, depth: number?): { [string]: any }
		local root = if inst == nil then game else resolveOrError(inst, "S.tree")
		return query.tree(root, depth or 2, {})
	end
	function api.props(inst: any, names: { string }?): { [string]: any }
		return query.props(resolveOrError(inst, "S.props"), names).props
	end
	function api.raycast(origin: Vector3, direction: Vector3, params: RaycastParams?): RaycastResult?
		return Workspace:Raycast(origin, direction, params)
	end
	function api.overlap(cframe: CFrame, size: Vector3, params: OverlapParams?): { BasePart }
		return Workspace:GetPartBoundsInBox(cframe, size, params)
	end
	function api.distance(a: any, b: any): number
		return (toPosition(a, "S.distance") - toPosition(b, "S.distance")).Magnitude
	end

	-- §6.2 build / edit
	function api.new(class: string, props: { [string]: any }?, parent: any?): Instance
		local ok, inst = pcall(Instance.new, class)
		if not ok then
			fail("S.new: cannot create '%s': %s", tostring(class), tostring(inst))
		end
		if props then
			applyProps(inst, props)
		end
		if parent ~= nil then
			inst.Parent = resolveOrError(parent, "S.new parent")
		end
		return inst
	end
	function api.set(target: any, props: { [string]: any }): Instance
		local inst = resolveOrError(target, "S.set")
		applyProps(inst, props)
		return inst
	end
	function api.batchSet(list: { any })
		for i, pair in ipairs(list) do
			local target = pair[1] or pair.inst
			local props = pair[2] or pair.props
			if target == nil or type(props) ~= "table" then
				fail("S.batchSet: entry %d must be {inst, props}", i)
			end
			api.set(target, props)
			if i % 64 == 0 then
				api.yield()
			end
		end
	end
	function api.clone(target: any, props: { [string]: any }?, parent: any?): Instance
		local src = resolveOrError(target, "S.clone")
		local c = src:Clone()
		if c == nil then
			fail("S.clone: %s is not Archivable", paths.of(src))
		end
		if props then
			applyProps(c, props)
		end
		c.Parent = if parent ~= nil then resolveOrError(parent, "S.clone parent") else src.Parent
		return c
	end
	-- Edit DM: detaches (Parent = nil) instead of Destroy(), because Destroy() locks Parent and the
	-- ChangeHistory recording could then neither Cancel (dry_run, error) nor Undo the removal. The
	-- instance is referenced in S.detached until the recording is finished. Play DMs Destroy() (ephemeral).
	function api.destroy(target: any): number
		if type(target) == "table" then
			local n = 0
			for _, t in ipairs(target) do
				n += api.destroy(t)
			end
			return n
		end
		local inst = resolveOrError(target, "S.destroy")
		if inst == game or inst.Parent == game then
			fail("S.destroy: refusing to destroy %s", paths.of(inst))
		end
		if env.role == "edit" then
			local ok, err = pcall(function()
				inst.Parent = nil
			end)
			if not ok then
				fail("S.destroy: cannot detach %s: %s", paths.of(inst), tostring(err))
			end
			table.insert(api.detached, inst)
		else
			inst:Destroy()
		end
		return 1
	end
	-- Create-if-missing (F10): resolves `path`; when absent, creates the missing segments (Folders
	-- above the leaf, the leaf as `class`, default Folder) and applies `props` to the new leaf only.
	-- An existing instance of another class is an error only when `class` was given explicitly:
	-- `S.ensure("Workspace.CoinRush")` accepts whatever another agent created there (Model, Folder…).
	-- Returns the instance and whether it was created.
	function api.ensure(path: any, class: string?, props: { [string]: any }?): (Instance, boolean)
		local explicit = type(class) == "string" and class ~= ""
		local cls = if explicit then class :: string else "Folder"
		local existing = if typeof(path) == "Instance" then path else paths.resolve(path)
		if existing ~= nil then
			if explicit and not existing:IsA(cls) then
				fail("S.ensure: %s is a %s, not a %s", paths.of(existing), existing.ClassName, cls)
			end
			return existing, false
		end
		if type(path) ~= "string" or path == "" then
			fail("S.ensure: expected a path string, got %s", typeof(path))
		end
		local segs = paths.parse(path)
		local node: Instance = game
		local start = 1
		if segs[1] == "game" then
			start = 2
		elseif segs[1] == "Workspace" or segs[1] == "workspace" then
			node = Workspace
			start = 2
		end
		local created = false
		for i = start, #segs do
			local seg = segs[i]
			local nxt: Instance? = node:FindFirstChild(seg)
			if nxt == nil and node == game then
				local ok, svc = pcall(game.GetService, game, seg)
				if ok and typeof(svc) == "Instance" then
					nxt = svc
				else
					fail("S.ensure: '%s' is not a service; cannot create children of game", seg)
				end
			end
			if nxt == nil then
				local isLeaf = i == #segs
				local okNew, inst = pcall(Instance.new, if isLeaf then cls else "Folder")
				if not okNew then
					fail("S.ensure: cannot create '%s': %s", cls, tostring(inst))
				end
				inst.Name = seg
				if isLeaf and props then
					local rest = table.clone(props)
					rest.Name, rest.Parent = nil, nil
					applyProps(inst, rest)
				end
				inst.Parent = node
				nxt = inst
				created = true
			end
			node = nxt :: Instance
		end
		if explicit and not node:IsA(cls) then
			fail("S.ensure: %s is a %s, not a %s", paths.of(node), node.ClassName, cls)
		end
		return node, created
	end
	function api.part(props: { [string]: any }?): Part
		local p = Instance.new("Part")
		p.Anchored = true
		p.Material = Enum.Material.SmoothPlastic
		p.TopSurface = Enum.SurfaceType.Smooth
		p.BottomSurface = Enum.SurfaceType.Smooth
		if props then
			applyProps(p, props)
		end
		if p.Parent == nil then
			p.Parent = Workspace
		end
		return p
	end
	function api.model(name: string, children: { Instance }?, parent: any?): Model
		local m = Instance.new("Model")
		m.Name = tostring(name)
		for _, child in ipairs(children or {}) do
			child.Parent = m
		end
		m.Parent = if parent ~= nil then resolveOrError(parent, "S.model parent") else Workspace
		return m
	end
	-- spec = { origin, cols, rows, step, make(i, j, position) }: columns advance along X, rows
	-- along Z (a Vector3 step may also raise each row by step.Y). BaseParts / Models returned by
	-- make are placed at the cell position.
	function api.grid(spec: { [string]: any }): { any }
		local origin = toPosition(spec.origin or Vector3.zero, "S.grid origin")
		local cols = math.max(1, math.floor(tonumber(spec.cols) or 1))
		local rows = math.max(1, math.floor(tonumber(spec.rows) or 1))
		local step: Vector3 = if typeof(spec.step) == "Vector3" then spec.step else Vector3.new(tonumber(spec.step) or 4, 0, tonumber(spec.step) or 4)
		local make = spec.make
		if type(make) ~= "function" then
			fail("S.grid: make must be a function(i, j, position)")
		end
		local out = {}
		local count = 0
		for i = 1, cols do
			for j = 1, rows do
				local pos = origin + Vector3.new((i - 1) * step.X, (j - 1) * step.Y, (j - 1) * step.Z)
				local made = make(i, j, pos)
				if typeof(made) == "Instance" then
					if made:IsA("BasePart") then
						made.Position = pos
						touch(made)
					elseif made:IsA("Model") then
						made:PivotTo(CFrame.new(pos))
						touch(made)
					end
				end
				if made ~= nil then
					table.insert(out, made)
				end
				count += 1
				if count % 64 == 0 then
					api.yield()
				end
			end
		end
		return out
	end
	function api.box(spec: { [string]: any }): Part
		local props = table.clone(spec)
		local cf = props.cframe
		local size = props.size
		props.cframe, props.size = nil, nil
		if typeof(cf) == "Vector3" then
			cf = CFrame.new(cf)
		end
		if typeof(cf) == "CFrame" then
			props.CFrame = cf
		end
		if typeof(size) == "Vector3" then
			props.Size = size
		end
		return api.part(props)
	end

	-- §6.2 geometry rules: parts must not intersect other parts (touching faces are fine) and must
	-- never be parented under a BasePart. `run` reports or rejects violations (§4.1 `geometry`);
	-- these helpers let a program place things right the first time.

	-- Rests `target` (BasePart / Model, or a path) on `onto` (BasePart / Model / path): the bottom of
	-- its bounding box on the top of the target's, `opts.gap` studs above (default 0). X / Z are kept
	-- (`align = "keep"`, default) or centred on the target (`align = "center"`). Returns the instance.
	function api.placeOn(target: any, onto: any, opts: { [string]: any }?): Instance
		local inst = resolveOrError(target, "S.placeOn")
		local base = resolveOrError(onto, "S.placeOn target")
		local o = opts or {}
		local ok, why = geometry.placeOn(inst, base, o.align, o.gap)
		if not ok then
			fail("S.placeOn: %s", tostring(why))
		end
		touch(inst)
		return inst
	end

	-- Resolves `opts.ignore` (an Instance, a path, or a list of those; descendants are ignored too).
	local function ignoreList(spec: any, what: string, into: { Instance }): { Instance }
		if spec == nil then
			return into
		end
		local items = if type(spec) == "table" and typeof(spec) ~= "Instance" then spec else { spec }
		for _, item in ipairs(items) do
			table.insert(into, resolveOrError(item, what .. " ignore"))
		end
		return into
	end

	-- Would a box at `cframe` (CFrame or Vector3) of `size` penetrate any Workspace part by more than
	-- `opts.tolerance` (default 0.05 studs)? Returns (fits, blockingPaths). The first argument may also
	-- be a BasePart / Model (or its path): its own box is tested and it is ignored itself, with `opts`
	-- as the second argument. `opts.ignore` excludes instances (with their descendants), `opts.max`
	-- caps the list (default 100).
	function api.fits(pose: any, size: any?, opts: { [string]: any }?): (boolean, { string })
		local o: { [string]: any } = {}
		local cf: CFrame
		local box: Vector3
		local ignore: { Instance } = {}
		if typeof(pose) == "Instance" or type(pose) == "string" then
			local inst = resolveOrError(pose, "S.fits")
			local bcf, bsize = geometry.box(inst)
			if bcf == nil or bsize == nil then
				fail("S.fits: %s is a %s; expected a BasePart or a Model", paths.of(inst), inst.ClassName)
			end
			cf, box = bcf :: CFrame, bsize :: Vector3
			table.insert(ignore, inst)
			if type(size) == "table" then
				o = size
			elseif type(opts) == "table" then
				o = opts
			end
		else
			if typeof(pose) == "Vector3" then
				cf = CFrame.new(pose)
			elseif typeof(pose) == "CFrame" then
				cf = pose
			else
				fail("S.fits: expected a CFrame, Vector3, BasePart or Model, got %s", typeof(pose))
			end
			if typeof(size) ~= "Vector3" then
				fail("S.fits: size must be a Vector3")
			end
			box = size :: Vector3
			if type(opts) == "table" then
				o = opts
			end
		end
		ignoreList(o.ignore, "S.fits", ignore)
		local blocking = geometry.blocking(cf, box, geometry.tolerance(o.tolerance), ignore, o.max)
		local out = table.create(#blocking)
		for i, part in ipairs(blocking) do
			out[i] = paths.of(part)
		end
		return #out == 0, out
	end

	-- Overlapping pairs among the BaseParts of `target` (a BasePart / Model / Folder, a path, or a
	-- list of those) against every Workspace part (`opts.against = "self"`: only among themselves):
	-- [{a, b, depth, aClass, bClass, approximate?, decor?}] plus {checked, total, sampled, ms}.
	-- `opts.tolerance` (0.05), `opts.max` entries (200).
	function api.overlaps(target: any, opts: { [string]: any }?): ({ geometry.Overlap }, geometry.Info)
		local o = opts or {}
		local parts = geometry.expand(target)
		return geometry.overlaps(parts, { tolerance = o.tolerance, max = o.max, against = o.against, budget = o.budget })
	end

	-- BaseParts of `target` (same forms as S.overlaps) whose Parent is a BasePart: [{path, parent, class}].
	function api.nested(target: any, max: number?): { geometry.Nested }
		local list = geometry.nested(geometry.expand(target), max)
		return list
	end

	-- Rounds the pivot position of a BasePart / Model to multiples of `step` (a number, or a Vector3
	-- per axis; 0 leaves that axis alone). Returns the instance.
	function api.snapToGrid(target: any, step: any): Instance
		local inst = resolveOrError(target, "S.snapToGrid")
		if not geometry.snapToGrid(inst, step) then
			fail("S.snapToGrid: %s is a %s; expected a BasePart or a Model", paths.of(inst), inst.ClassName)
		end
		touch(inst)
		return inst
	end

	local ui: { [string]: any } = {}
	function ui.screen(name: string, props: { [string]: any }?): ScreenGui
		local sg = Instance.new("ScreenGui")
		sg.Name = tostring(name)
		sg.ResetOnSpawn = false
		if props then
			applyProps(sg, props)
		end
		if sg.Parent == nil then
			local lp = Players.LocalPlayer
			if env.role == "client" and lp then
				sg.Parent = lp:WaitForChild("PlayerGui", 5)
			else
				sg.Parent = StarterGui
			end
		end
		return sg
	end
	local function uiNew(class: string, parent: any, props: { [string]: any }?): Instance
		local inst = Instance.new(class)
		if props then
			applyProps(inst, props)
		end
		if parent ~= nil then
			inst.Parent = resolveOrError(parent, "S.ui parent")
		end
		return inst
	end
	function ui.frame(parent: any, props: { [string]: any }?): Frame
		return uiNew("Frame", parent, props) :: Frame
	end
	function ui.text(parent: any, props: { [string]: any }?): TextLabel
		return uiNew("TextLabel", parent, props) :: TextLabel
	end
	function ui.button(parent: any, props: { [string]: any }?): TextButton
		return uiNew("TextButton", parent, props) :: TextButton
	end
	api.ui = ui

	-- §6.3 scripts
	local scriptApi: { [string]: any } = {}
	local function sourceContainer(target: any, what: string): LuaSourceContainer
		local inst = resolveOrError(target, what)
		if not inst:IsA("LuaSourceContainer") then
			fail("%s: %s is a %s, not a script", what, paths.of(inst), inst.ClassName)
		end
		return inst :: LuaSourceContainer
	end
	-- Reads what the human sees: an open editor tab may hold unsaved text that `Source` lacks,
	-- and patch() must not write the stale saved copy over it. `range = {from, to}` (1-based,
	-- inclusive lines) returns that slice; the second value is always the total line count, so a
	-- program can page a long script under the §7 8 KB string cap (F6).
	function scriptApi.get(target: any, range: { [string]: any }?): (string, number)
		local s = sourceContainer(target, "S.script.get")
		local source: string? = nil
		if env.scriptSource then
			source = env.scriptSource(s)
		end
		if source == nil then
			source = (s :: any).Source
		end
		if type(range) == "table" then
			local text, total = util.sliceLines(source :: string, range.from, range.to)
			return text, total
		end
		local _, total = util.sliceLines(source :: string)
		return source :: string, total
	end
	function scriptApi.set(target: any, source: string)
		local s = sourceContainer(target, "S.script.set")
		if env.scriptEditor then
			local ok, err = env.scriptEditor(s, source)
			if ok then
				return
			end
			fail("S.script.set: %s", tostring(err))
		end
		(s :: any).Source = source
	end
	function scriptApi.patch(target: any, find: string, replace: string, count: number?): number
		local source = scriptApi.get(target)
		local max = if count then math.max(0, math.floor(count)) else math.huge
		local done = 0
		local pieces = {}
		local pos = 1
		while done < max do
			local a, b = string.find(source, find, pos, true)
			if a == nil then
				break
			end
			table.insert(pieces, string.sub(source, pos, a - 1))
			table.insert(pieces, replace)
			pos = b + 1
			done += 1
		end
		if done > 0 then
			table.insert(pieces, string.sub(source, pos))
			scriptApi.set(target, table.concat(pieces))
		end
		return done
	end
	function scriptApi.restart(target: any)
		local s = sourceContainer(target, "S.script.restart")
		if not s:IsA("BaseScript") then
			fail("S.script.restart: %s is a ModuleScript (require cache unaffected; re-require a clone)", paths.of(s))
		end
		local bs = s :: BaseScript
		bs.Disabled = true
		task.wait()
		bs.Disabled = false
	end
	function scriptApi.create(class: string, name: string, parent: any, source: string): LuaSourceContainer
		local inst = api.new(class, { Name = name })
		if not inst:IsA("LuaSourceContainer") then
			inst:Destroy()
			fail("S.script.create: %s is not a script class", tostring(class))
		end
		(inst :: any).Source = source or ""
		inst.Parent = resolveOrError(parent, "S.script.create parent")
		return inst :: LuaSourceContainer
	end
	api.script = scriptApi

	-- Play-only helpers (§6.4 exposes them through ctx; here for programs on the client).
	function api.character(timeout: number?): (Model?, string?)
		if env.role ~= "client" then
			return nil, "wrong_dm"
		end
		local lp = Players.LocalPlayer
		if lp == nil then
			return nil
		end
		local deadline = os.clock() + (timeout or 10)
		while os.clock() < deadline do
			local char = lp.Character
			if char and char:FindFirstChild("HumanoidRootPart") then
				return char
			end
			if ctl then
				ctl.checkCancel()
			end
			task.wait(0.1)
		end
		return nil
	end
	-- Straight-line walk: Humanoid:MoveTo re-issued every Heartbeat until the goal is within 3 studs
	-- horizontally (and 8 vertically). No pathfinding: an obstacle or a goal on a deck above the
	-- character times out — use S.pathTo for those.
	function api.moveTo(position: any, timeout: number?): (boolean, string?)
		if env.role ~= "client" then
			return false, "wrong_dm"
		end
		local target = toPosition(position, "S.moveTo")
		local char = api.character(5)
		local humanoid = if char then char:FindFirstChildOfClass("Humanoid") else nil
		local root = if char then char:FindFirstChild("HumanoidRootPart") else nil
		if humanoid == nil or root == nil then
			return false, "no_character"
		end
		local deadline = os.clock() + (timeout or 10)
		while os.clock() < deadline do
			if ctl then
				ctl.checkCancel()
			end
			-- The default ControlModule overrides Move every frame, so MoveTo is re-issued.
			humanoid:MoveTo(target)
			-- Arrival is judged horizontally: callers rarely know the root's exact height above the goal.
			local delta = (root :: BasePart).Position - target
			if Vector2.new(delta.X, delta.Z).Magnitude < 3 and math.abs(delta.Y) < 8 then
				return true
			end
			RunService.Heartbeat:Wait()
		end
		return false, "timeout"
	end

	-- Pathfinding walk (F7): PathfindingService path from the character to `position`, walked
	-- waypoint by waypoint (MoveTo re-issued per Heartbeat, Jump on Jump waypoints). A waypoint that
	-- makes no progress for STUCK_S gets one jump, then the path is recomputed from the current
	-- position (up to PATH_RECOMPUTES times); a recompute whose path ends no closer to the goal than
	-- the previous one stops early. Blocks the calling thread until it returns (a controller calls it
	-- from a spawned task) and stops the walk on every exit. Returns reached plus a reason when not:
	-- "wrong_dm" | "no_character" (also when the character dies or despawns mid-walk) |
	-- "no_path:<PathStatus>" | "compute_error: …" | "unreachable:<studs>" (every waypoint walked, the
	-- navmesh ends short of the goal) | "stuck" | "timeout".
	function api.pathTo(position: any, timeout: number?, agentParams: { [string]: any }?): (boolean, string?)
		if env.role ~= "client" then
			return false, "wrong_dm"
		end
		local target = toPosition(position, "S.pathTo")
		local char = api.character(5)
		local humanoid = if char then char:FindFirstChildOfClass("Humanoid") else nil
		local root = if char then char:FindFirstChild("HumanoidRootPart") else nil
		if humanoid == nil or root == nil or char == nil then
			return false, "no_character"
		end
		local rootPart = root :: BasePart
		local character = char :: Model
		local deadline = os.clock() + (timeout or 20)
		local params: { [string]: any } = { AgentCanJump = true, AgentRadius = 2, AgentHeight = 5 }
		if type(agentParams) == "table" then
			for k, v in pairs(agentParams) do
				params[k] = v
			end
		end
		local function horizontalTo(pos: Vector3): number
			local delta = rootPart.Position - pos
			return Vector2.new(delta.X, delta.Z).Magnitude
		end
		local function arrived(): boolean
			return horizontalTo(target) < 3 and math.abs(rootPart.Position.Y - target.Y) < 8
		end
		local function alive(): boolean
			return character.Parent ~= nil and rootPart.Parent ~= nil and humanoid.Parent ~= nil and humanoid.Health > 0
		end
		-- The last MoveTo would otherwise keep the character walking for up to 8 s after the return.
		local function finish(reached: boolean, reason: string?): (boolean, string?)
			if alive() then
				pcall(humanoid.MoveTo, humanoid, rootPart.Position)
			end
			return reached, reason
		end
		local bestEnd = math.huge
		for _ = 1, PATH_RECOMPUTES do
			if arrived() then
				return finish(true)
			end
			if not alive() then
				return false, "no_character"
			end
			local okPath, path = pcall(PathfindingService.CreatePath, PathfindingService, params)
			if not okPath then
				return finish(false, "compute_error: " .. tostring(path))
			end
			local okCompute, err = pcall(path.ComputeAsync, path, rootPart.Position, target)
			if not okCompute then
				return finish(false, "compute_error: " .. tostring(err))
			end
			if path.Status ~= Enum.PathStatus.Success then
				return finish(false, "no_path:" .. path.Status.Name)
			end
			local waypoints = path:GetWaypoints()
			local last = waypoints[#waypoints]
			local endGap = if last then (Vector2.new(last.Position.X - target.X, last.Position.Z - target.Z)).Magnitude else math.huge
			if endGap >= bestEnd - 0.5 and endGap > 3 then
				-- The navmesh ends short of the goal and recomputing did not bring the path any closer.
				return finish(false, ("unreachable:%.1f"):format(horizontalTo(target)))
			end
			bestEnd = math.min(bestEnd, endGap)
			local recompute = false
			for i = 2, #waypoints do
				local wp = waypoints[i]
				if wp.Action == Enum.PathWaypointAction.Jump then
					humanoid.Jump = true
				end
				local best = math.huge
				local progressAt = os.clock()
				local jumped = false
				while true do
					if ctl and ctl.cancelled() then
						finish(false, "cancelled")
						ctl.checkCancel()
					end
					if not alive() then
						return false, "no_character"
					end
					if os.clock() >= deadline then
						return finish(false, "timeout")
					end
					humanoid:MoveTo(wp.Position)
					local delta = rootPart.Position - wp.Position
					local horizontal = Vector2.new(delta.X, delta.Z).Magnitude
					if horizontal < WAYPOINT_REACH and math.abs(delta.Y) < 6 then
						break
					end
					if horizontal < best - 0.25 then
						best = horizontal
						progressAt = os.clock()
					elseif os.clock() - progressAt > STUCK_S then
						if not jumped then
							jumped = true
							humanoid.Jump = true
							progressAt = os.clock()
						else
							recompute = true
							break
						end
					end
					RunService.Heartbeat:Wait()
				end
				if recompute then
					break
				end
			end
			if not recompute then
				if arrived() then
					return finish(true)
				end
				-- Every waypoint reached, goal still out of reach: the path ends short of it.
				return finish(false, ("unreachable:%.1f"):format(horizontalTo(target)))
			end
		end
		return finish(false, "stuck")
	end

	return api
end

return S
