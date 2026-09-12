--[[
	Geometry rules: overlapping parts and parts parented under parts — the two mistakes every
	agent-built scene shows ("parts in parts"). Used by `run` (report or reject after a program,
	protocol.md §4.1 `geometry`), `observe geometry` (§4.2, a whole subtree) and the S API
	(S.placeOn / S.fits / S.overlaps / S.snapToGrid, §6.2).

	Overlaps: one workspace:GetPartBoundsInBox per part over the part's own box shrunk by
	`tolerance` on every side, so faces that merely touch (a tile on a floor, wall segments end to
	end) are never overlaps. The engine answers with bounding boxes; a pair of block Parts is then
	confirmed by a separating-axis test of the two oriented boxes (exact; the penetration depth is
	the smallest axis overlap), every other pair (wedges, spheres, cylinders, meshes, unions,
	trusses) is kept as the engine reported it, flagged `approximate`, with the overlap of the two
	world AABBs as depth. Terrain is never a candidate; CanCollide = false decor is reported and
	flagged `decor`. Parts with CanQuery = false are invisible to the engine query.

	Nested: a BasePart whose Parent is a BasePart. Attachments, decals, textures, lights,
	constraints and scripts under a part are fine; Models and Folders are the containers for parts.
]]

local Workspace = game:GetService("Workspace")

local paths = require(script.Parent.paths)
local util = require(script.Parent.util)

local geometry = {}

geometry.DEFAULT_TOLERANCE = 0.05
-- Entries a report keeps per list (the totals still count everything found).
geometry.DEFAULT_MAX = 200
-- Parts one report queries at most; a larger set is sampled with a stride and flagged `sampled`.
geometry.MAX_PARTS = 5000
-- BaseParts collected under an observe root at most (the report samples from them).
geometry.COLLECT_MAX = 50000
-- Work budgets (engine queries plus the box tests, frames waited excluded): a report stops early
-- (and says `sampled`) rather than stall a request. A run's budget is also bounded by the request's
-- remaining deadline (runner.run).
geometry.RUN_BUDGET_S = 0.5
geometry.OBSERVE_BUDGET_S = 2
-- Work between frame yields (the S.yield slice, §6.5): past it the loop waits one Heartbeat when it
-- runs in a yieldable thread, so a 5000-part audit never freezes Studio for its whole budget.
geometry.SLICE_S = 0.008
-- Entries the run body carries per list.
geometry.RUN_ENTRIES = 50
-- Bytes a warning line may hold (two deep paths plus the sentence).
geometry.WARNING_MAX_BYTES = 1024
-- Candidates one engine query may return; a part buried in more is reported against the first ones.
local QUERY_MAX_PARTS = 100

export type Overlap = {
	a: string,
	b: string,
	depth: number,
	aClass: string,
	bClass: string,
	approximate: boolean?,
	decor: boolean?,
}
export type Nested = { path: string, parent: string, class: string }
-- `outside`: parts skipped because they are not under Workspace (engine spatial queries cover
-- Workspace only; nesting is still checked for them). `ms` is work time (frames waited excluded);
-- `yields` counts the Heartbeats waited between slices.
export type Info = { checked: number, total: number, sampled: boolean, ms: number, outside: number, yields: number }
export type Report = {
	overlaps: { Overlap },
	nested: { Nested },
	checked: number,
	sampled: boolean,
	ms: number,
	outside: number,
	totals: { overlaps: number, nested: number },
}
export type Options = {
	tolerance: number?,
	max: number?,
	-- "all" (default): against every part in Workspace; "self": only among the given parts.
	against: string?,
	maxParts: number?,
	budget: number?,
	include_nested: boolean?,
	-- The caller already knows the part list is incomplete (journal overflow, collect cap): the
	-- report says `sampled` even when every listed part was checked.
	partial: boolean?,
}

function geometry.tolerance(v: any): number
	return util.num(v, geometry.DEFAULT_TOLERANCE, 0, 100)
end

-- Half extents of an oriented box's world AABB: |R| × half size.
local function aabbHalf(cf: CFrame, size: Vector3): Vector3
	local h = size / 2
	local x, y, z = cf.XVector, cf.YVector, cf.ZVector
	return Vector3.new(
		math.abs(x.X) * h.X + math.abs(y.X) * h.Y + math.abs(z.X) * h.Z,
		math.abs(x.Y) * h.X + math.abs(y.Y) * h.Y + math.abs(z.Y) * h.Z,
		math.abs(x.Z) * h.X + math.abs(y.Z) * h.Y + math.abs(z.Z) * h.Z
	)
end

-- Oriented box (CFrame + size) of a BasePart or a Model (its bounding box); nil for anything else.
function geometry.box(inst: Instance): (CFrame?, Vector3?)
	if inst:IsA("BasePart") then
		return inst.CFrame, inst.Size
	elseif inst:IsA("Model") then
		local ok, cf, size = pcall(inst.GetBoundingBox, inst)
		if ok and typeof(cf) == "CFrame" and typeof(size) == "Vector3" then
			return cf, size
		end
	end
	return nil, nil
end

-- World AABB (min, max) of a BasePart or a Model.
function geometry.bounds(inst: Instance): (Vector3?, Vector3?)
	local cf, size = geometry.box(inst)
	if cf == nil or size == nil then
		return nil, nil
	end
	local half = aabbHalf(cf, size)
	return cf.Position - half, cf.Position + half
end

-- True for a plain block Part: the one shape whose volume is exactly its box.
local function isBlock(part: BasePart): boolean
	if part.ClassName ~= "Part" then
		return false
	end
	local ok, shape = pcall(function()
		return (part :: Part).Shape
	end)
	return ok and shape == Enum.PartType.Block
end

-- Separating-axis test of two oriented boxes (half sizes ha / hb). Returns the penetration depth
-- (the smallest overlap over the 15 candidate axes) or nil when a separating axis exists.
function geometry.obbDepth(ca: CFrame, ha: Vector3, cb: CFrame, hb: Vector3): number?
	local axesA = { ca.XVector, ca.YVector, ca.ZVector }
	local axesB = { cb.XVector, cb.YVector, cb.ZVector }
	local hA = { ha.X, ha.Y, ha.Z }
	local hB = { hb.X, hb.Y, hb.Z }
	local d = cb.Position - ca.Position
	local best = math.huge
	local function separated(axis: Vector3): boolean
		local len = axis.Magnitude
		if len < 1e-6 then
			return false -- parallel edges: this cross product carries no information
		end
		axis = axis / len
		local ra = hA[1] * math.abs(axesA[1]:Dot(axis)) + hA[2] * math.abs(axesA[2]:Dot(axis)) + hA[3] * math.abs(axesA[3]:Dot(axis))
		local rb = hB[1] * math.abs(axesB[1]:Dot(axis)) + hB[2] * math.abs(axesB[2]:Dot(axis)) + hB[3] * math.abs(axesB[3]:Dot(axis))
		local overlap = ra + rb - math.abs(d:Dot(axis))
		if overlap <= 0 then
			return true
		end
		if overlap < best then
			best = overlap
		end
		return false
	end
	for i = 1, 3 do
		if separated(axesA[i]) or separated(axesB[i]) then
			return nil
		end
	end
	for i = 1, 3 do
		for j = 1, 3 do
			if separated(axesA[i]:Cross(axesB[j])) then
				return nil
			end
		end
	end
	return best
end

-- Penetration of two boxes beyond `tol`: exact (SAT) when both are block Parts, else the overlap
-- of their world AABBs, flagged approximate. nil when separated or within the tolerance.
local function pairDepth(cfA: CFrame, sizeA: Vector3, exactA: boolean, cfB: CFrame, sizeB: Vector3, exactB: boolean, tol: number): (number?, boolean)
	if exactA and exactB then
		local depth = geometry.obbDepth(cfA, sizeA / 2, cfB, sizeB / 2)
		if depth == nil or depth <= tol then
			return nil, false
		end
		return depth, false
	end
	local ha, hb = aabbHalf(cfA, sizeA), aabbHalf(cfB, sizeB)
	local pa, pb = cfA.Position, cfB.Position
	local dx = math.min(pa.X + ha.X, pb.X + hb.X) - math.max(pa.X - ha.X, pb.X - hb.X)
	local dy = math.min(pa.Y + ha.Y, pb.Y + hb.Y) - math.max(pa.Y - ha.Y, pb.Y - hb.Y)
	local dz = math.min(pa.Z + ha.Z, pb.Z + hb.Z) - math.max(pa.Z - ha.Z, pb.Z - hb.Z)
	local depth = math.min(dx, dy, dz)
	if depth <= tol then
		return nil, true
	end
	return depth, true
end

local function newParams(): OverlapParams
	local params = OverlapParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.MaxParts = QUERY_MAX_PARTS
	params.RespectCanCollide = false
	return params
end

local function shrunk(size: Vector3, tol: number): Vector3
	return Vector3.new(
		math.max(size.X - 2 * tol, 0.001),
		math.max(size.Y - 2 * tol, 0.001),
		math.max(size.Z - 2 * tol, 0.001)
	)
end

-- Parts whose bounding boxes reach into the box `cf`/`size` shrunk by `tol` on every side.
function geometry.candidates(cf: CFrame, size: Vector3, tol: number, params: OverlapParams): { BasePart }
	local ok, list = pcall(Workspace.GetPartBoundsInBox, Workspace, cf, shrunk(size, tol), params)
	if ok and type(list) == "table" then
		return list
	end
	return {}
end

-- Overlapping pairs among `parts` (against every Workspace part, or only each other with
-- against = "self"); each part once even when listed twice, each unordered pair once. Parts outside
-- Workspace are skipped (counted as `outside`). Yields a Heartbeat after every SLICE_S of work when
-- the calling thread can yield; the budget counts work only.
-- A fully transparent, non-colliding BasePart is a marker (spawn spot, waypoint, trigger volume),
-- not geometry: it never overlaps anything and nothing overlaps it. (Measured: an arena's invisible
-- CoinSpot markers inside wedge ramps were the only "overlaps" left after real fixes.)
function geometry.isMarker(part: BasePart): boolean
	return part.Transparency >= 1 and not part.CanCollide
end

function geometry.overlaps(parts: { BasePart }, opts: Options?): ({ Overlap }, Info)
	local o: Options = opts or {}
	local tol = geometry.tolerance(o.tolerance)
	local max = math.floor(util.num(o.max, geometry.DEFAULT_MAX, 0, 10000))
	local maxParts = math.floor(util.num(o.maxParts, geometry.MAX_PARTS, 1, geometry.MAX_PARTS))
	local budget = util.num(o.budget, geometry.RUN_BUDGET_S, 0.01, 60)
	local selfOnly = o.against == "self"
	local set: { [BasePart]: boolean } = {}
	if selfOnly then
		for _, p in ipairs(parts) do
			set[p] = true
		end
	end
	local stride = 1
	local sampled = false
	if #parts > maxParts then
		stride = math.ceil(#parts / maxParts)
		sampled = true
	end
	local params = newParams()
	-- Terrain never counts, so the engine need not even return it.
	local terrain: Instance? = Workspace:FindFirstChildOfClass("Terrain")
	local seen: { [BasePart]: { [BasePart]: boolean } } = {}
	local done: { [BasePart]: boolean } = {}
	local exactCache: { [BasePart]: boolean } = {}
	local function exact(p: BasePart): boolean
		local e = exactCache[p]
		if e == nil then
			e = isBlock(p)
			exactCache[p] = e
		end
		return e
	end
	local list: { Overlap } = {}
	local total = 0
	local checked = 0
	local outside = 0
	local worked = 0
	local yields = 0
	local sliceStart = os.clock()
	for i = 1, #parts, stride do
		local now = os.clock()
		if now - sliceStart > geometry.SLICE_S then
			worked += now - sliceStart
			if worked > budget then
				sampled = true
				sliceStart = os.clock()
				break
			end
			if coroutine.isyieldable() then
				task.wait()
				yields += 1
			end
			sliceStart = os.clock()
		end
		local part = parts[i]
		if typeof(part) ~= "Instance" or not part:IsA("BasePart") or part:IsA("Terrain") or done[part] then
			-- not a part, or already checked (a list may name one twice)
		elseif not part:IsDescendantOf(Workspace) then
			done[part] = true
			outside += 1
		elseif geometry.isMarker(part) then
			-- Invisible, non-colliding helper parts (spawn spots, waypoints, triggers) are not geometry.
			done[part] = true
		else
			done[part] = true
			checked += 1
			local cf, size = part.CFrame, part.Size
			params.FilterDescendantsInstances = if terrain then { part, terrain } else { part }
			for _, other in ipairs(geometry.candidates(cf, size, tol, params)) do
				if other ~= part and not other:IsA("Terrain") and not geometry.isMarker(other) and (not selfOnly or set[other]) then
					local mine = seen[part]
					local fromOther = seen[other]
					if not ((fromOther and fromOther[part]) or (mine and mine[other])) then
						if mine == nil then
							mine = {}
							seen[part] = mine
						end
						mine[other] = true
						local depth, approximate = pairDepth(cf, size, exact(part), other.CFrame, other.Size, exact(other), tol)
						if depth ~= nil then
							total += 1
							if #list < max then
								local entry: Overlap = {
									a = paths.of(part),
									b = paths.of(other),
									depth = util.round(depth, 2),
									aClass = part.ClassName,
									bClass = other.ClassName,
								}
								if approximate then
									entry.approximate = true
								end
								if not part.CanCollide or not other.CanCollide then
									entry.decor = true
								end
								table.insert(list, entry)
							end
						end
					end
				end
			end
		end
	end
	worked += os.clock() - sliceStart
	return list, { checked = checked, total = total, sampled = sampled, ms = util.round(worked * 1000, 1), outside = outside, yields = yields }
end

-- BaseParts among `parts` (a list, or a root Instance whose BasePart descendants are meant) whose
-- Parent is a BasePart (only while still in the DataModel).
function geometry.nested(parts: { BasePart } | Instance, max: number?): ({ Nested }, number)
	local cap = math.floor(util.num(max, geometry.DEFAULT_MAX, 0, 10000))
	local list: { Nested } = {}
	local total = 0
	local items: { BasePart } = if typeof(parts) == "Instance" then (geometry.collect(parts :: Instance)) else parts :: { BasePart }
	for _, part in ipairs(items) do
		if typeof(part) == "Instance" and part:IsA("BasePart") then
			local parent = part.Parent
			if parent ~= nil and parent:IsA("BasePart") and part:IsDescendantOf(game) then
				total += 1
				if #list < cap then
					table.insert(list, { path = paths.of(part), parent = paths.of(parent), class = part.ClassName })
				end
			end
		end
	end
	return list, total
end

-- Every BasePart under `root` (root included when it is one; Terrain never), at most `cap`.
-- The second value says the cap was hit.
function geometry.collect(root: Instance, cap: number?): ({ BasePart }, boolean)
	local limit = math.floor(util.num(cap, geometry.COLLECT_MAX, 1))
	local out: { BasePart } = {}
	local overflow = false
	if root:IsA("BasePart") and not root:IsA("Terrain") then
		table.insert(out, root)
	end
	local ok, list = pcall(root.GetDescendants, root)
	if ok and type(list) == "table" then
		for _, inst in ipairs(list) do
			if inst:IsA("BasePart") and not inst:IsA("Terrain") then
				if #out >= limit then
					overflow = true
					break
				end
				table.insert(out, inst)
			end
		end
	end
	return out, overflow
end

-- Expands an Instance (a BasePart, or a container whose BasePart descendants are meant), a path,
-- or a list of those into a flat list of BaseParts.
function geometry.expand(target: any, cap: number?): { BasePart }
	local out: { BasePart } = {}
	local limit = math.floor(util.num(cap, geometry.COLLECT_MAX, 1))
	local function add(inst: Instance)
		if inst:IsA("BasePart") then
			if not inst:IsA("Terrain") and #out < limit then
				table.insert(out, inst)
			end
			return
		end
		for _, p in ipairs((geometry.collect(inst, limit - #out))) do
			table.insert(out, p)
		end
	end
	local function visit(v: any)
		if typeof(v) == "Instance" then
			add(v)
		elseif type(v) == "string" then
			local inst = paths.resolve(v)
			if inst then
				add(inst)
			end
		elseif type(v) == "table" then
			for _, item in ipairs(v) do
				visit(item)
			end
		end
	end
	visit(target)
	return out
end

-- Overlaps plus nesting for one set of parts (the run integration and observe geometry). `ms` is
-- work time: the overlap check's slices plus the nesting pass, frames waited excluded.
function geometry.report(parts: { BasePart }, opts: Options?): Report
	local o: Options = opts or {}
	local overlaps, info = geometry.overlaps(parts, o)
	local t1 = os.clock()
	local nested: { Nested } = {}
	local nestedTotal = 0
	if o.include_nested ~= false then
		nested, nestedTotal = geometry.nested(parts, o.max)
	end
	return {
		overlaps = overlaps,
		nested = nested,
		checked = info.checked,
		sampled = info.sampled or o.partial == true,
		ms = util.round(info.ms + (os.clock() - t1) * 1000, 1),
		outside = info.outside,
		totals = { overlaps = info.total, nested = nestedTotal },
	}
end

function geometry.isEmpty(report: Report): boolean
	return report.totals.overlaps == 0 and report.totals.nested == 0
end

-- The run body's copy: at most `entries` per list; totals and counters kept, `sampled` only when set.
function geometry.trim(report: Report, entries: number?): { [string]: any }
	local n = math.floor(util.num(entries, geometry.RUN_ENTRIES, 0))
	local function head(list: { any }): { any }
		local out = table.create(math.min(n, #list))
		for i = 1, math.min(n, #list) do
			out[i] = list[i]
		end
		return out
	end
	local out: { [string]: any } = {
		overlaps = head(report.overlaps),
		nested = head(report.nested),
		checked = report.checked,
		ms = report.ms,
		totals = { overlaps = report.totals.overlaps, nested = report.totals.nested },
	}
	if report.sampled then
		out.sampled = true
	end
	if report.outside > 0 then
		out.outside = report.outside
	end
	return out
end

geometry.POLICIES = { warn = true, reject = true, off = true }

-- Normalises a `geometry_policy` body field: nil → `default`; an unknown value → nil plus a message.
function geometry.policy(v: any, default: string?): (string?, string?)
	if v == nil then
		return default, nil
	end
	if type(v) == "string" and geometry.POLICIES[v] then
		return v, nil
	end
	return nil, ("geometry_policy must be 'warn', 'reject' or 'off' (got %s)"):format(tostring(v))
end

-- One warning line per non-empty list, naming the first offender (paths cut so a line stays
-- under WARNING_MAX_BYTES; the sentence's tail — "see geometry" — always survives).
function geometry.warnings(report: Report): { string }
	local out: { string } = {}
	local function name(path: string): string
		return util.truncate(path, math.floor(geometry.WARNING_MAX_BYTES / 3))
	end
	local n = report.totals.overlaps
	if n > 0 then
		local first = report.overlaps[1]
		local example = if first
			then (" (e.g. %s ⟂ %s, %s stud%s%s)"):format(name(first.a), name(first.b), tostring(first.depth), if first.depth == 1 then "" else "s", if first.approximate then ", approximate" else "")
			else ""
		table.insert(out, ("%d overlapping part pair%s%s — fix before continuing (move, resize or S.placeOn them); see geometry"):format(n, if n == 1 then "" else "s", example))
	end
	local m = report.totals.nested
	if m > 0 then
		local first = report.nested[1]
		local example = if first then (" (e.g. %s under %s)"):format(name(first.path), name(first.parent)) else ""
		table.insert(out, ("%d part%s parented under another part%s — parts belong in a Model or Folder, never under a BasePart; see geometry"):format(m, if m == 1 then "" else "s", example))
	end
	return out
end

-- Parts a box at `cf`/`size` would penetrate by more than `tol`, `ignore` (with descendants)
-- excluded. Exact against block Parts, bounds-based against the rest. At most `max`.
function geometry.blocking(cf: CFrame, size: Vector3, tol: number, ignore: { Instance }, max: number?): { BasePart }
	local params = newParams()
	params.FilterDescendantsInstances = ignore
	local out: { BasePart } = {}
	local limit = math.floor(util.num(max, QUERY_MAX_PARTS, 1))
	for _, other in ipairs(geometry.candidates(cf, size, tol, params)) do
		if not other:IsA("Terrain") then
			local depth = pairDepth(cf, size, true, other.CFrame, other.Size, isBlock(other), tol)
			if depth ~= nil then
				table.insert(out, other)
				if #out >= limit then
					break
				end
			end
		end
	end
	return out
end

-- Pivot of a BasePart / Model (nil otherwise).
function geometry.pivot(inst: Instance): CFrame?
	if inst:IsA("BasePart") then
		return inst.CFrame
	elseif inst:IsA("Model") then
		return inst:GetPivot()
	end
	return nil
end

-- Moves a BasePart / Model so its pivot sits at `position`, keeping its rotation.
function geometry.moveTo(inst: Instance, position: Vector3): boolean
	if inst:IsA("BasePart") then
		inst.CFrame = CFrame.new(position) * inst.CFrame.Rotation
		return true
	elseif inst:IsA("Model") then
		inst:PivotTo(CFrame.new(position) * inst:GetPivot().Rotation)
		return true
	end
	return false
end

-- Rests `inst` (BasePart / Model) on `target` (BasePart / Model): the bottom of its world AABB on
-- the top of the target's, `gap` studs above; X/Z kept (align "keep", default) or centred on the
-- target's AABB (align "center"). Rotation is kept.
function geometry.placeOn(inst: Instance, target: Instance, align: string?, gap: number?): (boolean, string?)
	local tMin, tMax = geometry.bounds(target)
	if tMin == nil or tMax == nil then
		return false, ("target %s is a %s; expected a BasePart or a Model"):format(paths.of(target), target.ClassName)
	end
	local iMin = geometry.bounds(inst)
	local pivot = geometry.pivot(inst)
	if iMin == nil or pivot == nil then
		return false, ("%s is a %s; expected a BasePart or a Model"):format(paths.of(inst), inst.ClassName)
	end
	local p = pivot.Position
	local x, z = p.X, p.Z
	if align == "center" then
		x, z = (tMin.X + tMax.X) / 2, (tMin.Z + tMax.Z) / 2
	end
	local y = tMax.Y + (tonumber(gap) or 0) + (p.Y - iMin.Y)
	geometry.moveTo(inst, Vector3.new(x, y, z))
	return true, nil
end

-- Rounds the pivot position of a BasePart / Model to multiples of `step` (number or Vector3).
function geometry.snapToGrid(inst: Instance, step: any): boolean
	local s: Vector3
	if typeof(step) == "Vector3" then
		s = step
	else
		local n = tonumber(step) or 1
		s = Vector3.new(n, n, n)
	end
	local pivot = geometry.pivot(inst)
	if pivot == nil then
		return false
	end
	local function snap(v: number, k: number): number
		return if k > 0 then math.floor(v / k + 0.5) * k else v
	end
	local p = pivot.Position
	return geometry.moveTo(inst, Vector3.new(snap(p.X, s.X), snap(p.Y, s.Y), snap(p.Z, s.Z)))
end

return geometry
