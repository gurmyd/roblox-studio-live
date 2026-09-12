--[[
	DescendantAdded / DescendantRemoving journal for the local DataModel.

	Backs `observe diff` (paths since a cursor), per-run change counting (mark/collect)
	and the throttled `change` event (≤ 2/s, only outside a run).
]]

local RunService = game:GetService("RunService")

local paths = require(script.Parent.paths)
local Ring = require(script.Parent.ring)

local Journal = {}
Journal.__index = Journal

-- Studio- and engine-internal trees churn constantly and are never what the agent means (live: a client
-- `run` reported `VoiceChatInternal` as its only change). Matched on the top-level ancestor's Name and
-- ClassName; any top-level name starting with "RobloxReplicated" is ignored as well.
local IGNORED_TOP: { [string]: boolean } = {
	CoreGui = true,
	CorePackages = true,
	PluginGuiService = true,
	RobloxPluginGuiService = true,
	StudioService = true,
	RobloxReplicatedStorage = true,
	VoiceChatInternal = true,
	Stats = true,
}
local IGNORED_PREFIX = "RobloxReplicated"

-- True when a top-level (service-level) name is excluded from the journal.
function Journal.isIgnoredName(name: string): boolean
	return IGNORED_TOP[name] == true or string.sub(name, 1, #IGNORED_PREFIX) == IGNORED_PREFIX
end

export type Journal = typeof(setmetatable(
	{} :: {
		ring: Ring.Ring,
		seq: number,
		activeRuns: number,
		pendingAdded: number,
		pendingRemoved: number,
		connections: { RBXScriptConnection },
		emit: ((ev: { [string]: any }) -> number)?,
		lastFlush: number,
		-- Last known parent of every instance this journal has seen with a live ancestry (weak keys:
		-- the entry goes with the instance). Consulted for removals, whose handlers run after the
		-- detachment under Deferred signal behaviour (Parent is already nil then).
		parents: { [Instance]: Instance },
	},
	Journal
))

-- Instances of the ignored trees remembered up front, so a pre-existing internal instance that is
-- removed later is still recognised as internal (anything added after start is remembered as it comes).
local SNAPSHOT_MAX = 20000
-- Ancestry walks stop here (a cycle through remembered parents would otherwise spin).
local MAX_DEPTH = 128

function Journal.new(capacity: number?): Journal
	local self = setmetatable({
		ring = Ring.new(capacity or 4000),
		seq = 0,
		activeRuns = 0,
		pendingAdded = 0,
		pendingRemoved = 0,
		connections = {},
		emit = nil,
		lastFlush = os.clock(),
		parents = setmetatable({}, { __mode = "k" }) :: any,
	}, Journal)
	return self
end

-- Top-level (service-level) ancestor and full path of `inst`, following the live ancestry where it
-- exists and the remembered parents where it no longer does. Both nil when the origin is unknown
-- (an instance this journal never saw attached, detached before its handler ran).
function Journal.locate(self: Journal, inst: Instance): (Instance?, string?)
	local names = {}
	local node: Instance = inst
	for _ = 1, MAX_DEPTH do
		table.insert(names, 1, node.Name)
		local parent: Instance? = node.Parent
		if parent == nil then
			parent = self.parents[node]
		end
		if parent == nil then
			return nil, nil
		elseif parent == game then
			return node, paths.join(names)
		end
		node = parent
	end
	return nil, nil
end

local function ignoredTop(inst: Instance): boolean
	return Journal.isIgnoredName(inst.Name) or Journal.isIgnoredName(inst.ClassName)
end

function Journal.record(self: Journal, kind: string, inst: Instance)
	local parent = inst.Parent
	if parent ~= nil then
		-- Live ancestry: remember it for the removal that may come later.
		self.parents[inst] = parent
	end
	local top, path = self:locate(inst)
	if top ~= nil then
		if ignoredTop(top) then
			return
		end
	elseif kind == "added" then
		-- An instance that is no longer in the DataModel by the time its Added handler runs (parented
		-- and detached in the same step) has nothing to count.
		return
	else
		-- Removal of an instance whose origin was never seen: count it under its own name so a delete
		-- is never silently dropped (a pre-existing instance detached by a program, live finding).
		path = paths.of(inst)
		if ignoredTop(inst) then
			return
		end
	end
	self.seq += 1
	-- `inst` is kept (never serialised) so a run can hand the BaseParts it added to the geometry
	-- check without re-resolving paths that the program may have changed since.
	self.ring:push({ seq = self.seq, kind = kind, path = path, t = os.clock(), inst = inst })
	if kind == "added" then
		self.pendingAdded += 1
	else
		self.pendingRemoved += 1
	end
end

-- Remembers the parents of what the ignored trees hold right now (capped), so their later removals
-- are recognised as internal even though their Added handlers never ran here.
function Journal.snapshotIgnored(self: Journal): number
	local remembered = 0
	for _, svc in ipairs(game:GetChildren()) do
		if remembered >= SNAPSHOT_MAX then
			break
		end
		if Journal.isIgnoredName(svc.Name) or Journal.isIgnoredName(svc.ClassName) then
			local ok, list = pcall(svc.GetDescendants, svc)
			if ok and type(list) == "table" then
				for _, inst in ipairs(list) do
					local parent = inst.Parent
					if parent ~= nil then
						self.parents[inst] = parent
						remembered += 1
						if remembered >= SNAPSHOT_MAX then
							break
						end
					end
				end
			end
		end
	end
	return remembered
end

-- Starts listening; `emit` (optional) receives throttled `change` events.
function Journal.start(self: Journal, emit: ((ev: { [string]: any }) -> number)?)
	self.emit = emit
	pcall(self.snapshotIgnored, self)
	table.insert(
		self.connections,
		game.DescendantAdded:Connect(function(inst)
			self:record("added", inst)
		end)
	)
	table.insert(
		self.connections,
		game.DescendantRemoving:Connect(function(inst)
			self:record("removed", inst)
		end)
	)
	if emit then
		table.insert(
			self.connections,
			RunService.Heartbeat:Connect(function()
				local now = os.clock()
				if now - self.lastFlush < 0.5 then
					return
				end
				self.lastFlush = now
				if self.activeRuns > 0 then
					-- Changes made during a run are reported in that run's response instead.
					self.pendingAdded, self.pendingRemoved = 0, 0
					return
				end
				if self.pendingAdded > 0 or self.pendingRemoved > 0 then
					local added, removed = self.pendingAdded, self.pendingRemoved
					self.pendingAdded, self.pendingRemoved = 0, 0
					pcall(emit, { type = "change", added = added, removed = removed })
				end
			end)
		)
	end
end

function Journal.stop(self: Journal)
	for _, c in ipairs(self.connections) do
		c:Disconnect()
	end
	self.connections = {}
end

-- Cursor for a run; pair with collect(cursor) after it finishes.
function Journal.mark(self: Journal): number
	self.activeRuns += 1
	return self.seq
end

function Journal.release(self: Journal)
	self.activeRuns = math.max(0, self.activeRuns - 1)
	if self.activeRuns == 0 then
		-- Everything recorded while a run was active went into that run's `changes`; the throttled
		-- `change` event must not report it a second time (the Heartbeat flush may not have run yet).
		self.pendingAdded, self.pendingRemoved = 0, 0
	end
end

-- Change summary since `cursor`: counts plus up to `maxPaths` distinct top-most paths.
function Journal.collect(self: Journal, cursor: number, maxPaths: number?): { [string]: any }
	local added, removed = 0, 0
	local seen: { [string]: boolean } = {}
	local list = {}
	local cap = maxPaths or 20
	for _, item in ipairs(self.ring:since(cursor)) do
		if item.kind == "added" then
			added += 1
		else
			removed += 1
		end
		if #list < cap then
			-- Collapse descendants of an already-listed path so a 2000-part build lists its root.
			local covered = false
			for listed in pairs(seen) do
				if item.path == listed or string.sub(item.path, 1, #listed + 1) == listed .. "." then
					covered = true
					break
				end
			end
			if not covered then
				seen[item.path] = true
				table.insert(list, item.path)
			end
		end
	end
	return { added = added, removed = removed, paths = list }
end

-- Distinct instances recorded as added since `cursor` that are still in the DataModel, oldest
-- first, filtered by `pred` (default: BaseParts other than Terrain), at most `cap`. The second value
-- says the cap was hit. Feeds the geometry check of a run (protocol §4.1 `geometry`).
function Journal.addedInstances(self: Journal, cursor: number, cap: number?, pred: ((Instance) -> boolean)?): ({ Instance }, boolean)
	local limit = cap or 5000
	local out: { Instance } = {}
	local seen: { [Instance]: boolean } = {}
	-- A run that added more than the ring holds lost its oldest entries: the list is then partial.
	local oldest = self.ring:at(1)
	local overflow = oldest ~= nil and type(oldest.seq) == "number" and oldest.seq > cursor + 1
	for _, item in ipairs(self.ring:since(cursor)) do
		local inst = item.inst
		if item.kind == "added" and typeof(inst) == "Instance" and not seen[inst] then
			seen[inst] = true
			local keep = if pred then pred(inst) else inst:IsA("BasePart") and not inst:IsA("Terrain")
			if keep and inst:IsDescendantOf(game) then
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

-- `observe diff` body.
function Journal.diff(self: Journal, since: number, maxPaths: number?): { [string]: any }
	local cap = maxPaths or 500
	local added, removed = {}, {}
	local truncated = false
	for _, item in ipairs(self.ring:since(since)) do
		local bucket = if item.kind == "added" then added else removed
		if #bucket < cap then
			table.insert(bucket, item.path)
		else
			truncated = true
		end
	end
	local oldest = self.ring:at(1)
	if oldest ~= nil and since + 1 < oldest.seq and since > 0 then
		truncated = true -- the ring no longer covers the cursor
	end
	return { since = since, now = self.seq, added = added, removed = removed, truncated = truncated }
end

return Journal
