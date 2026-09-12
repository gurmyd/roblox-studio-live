--[[ studio-live skill
name: settle_physics
description: Edit DM: steps physics (workspace:StepPhysics, one call of dt <= 0.5 s per frame) for ARGS.seconds over the unanchored BaseParts under ARGS.paths so loose parts come to rest; returns final positions. One undo step. Each step costs one frame (~17 ms), so ceil(seconds/dt) steps must fit the run's timeout_ms; the skill refuses (bad_request) when they cannot and says which dt or timeout_ms would.
params: {"paths":{"type":"array","items":{"type":"string"},"description":"instance paths whose unanchored BasePart descendants are simulated (default [\"Workspace\"])"},"seconds":{"type":"number","default":2,"minimum":0,"maximum":60,"description":"simulated seconds"},"dt":{"type":"number","default":0.5,"minimum":0.01,"maximum":0.5,"description":"simulated seconds per StepPhysics call; the engine applies one call per frame, so steps = ceil(seconds/dt) frames of wall time (timeout_ms >= steps x 17 ms + margin)"},"max_parts":{"type":"integer","default":200,"description":"cap on positions returned"}}
]]
-- StepPhysics is edit-mode only (live-measurements §2); a playtest simulates on its own.
if S.role ~= "edit" then
	error("settle_physics runs in the edit DM (dm='edit'); a running playtest already simulates physics", 0)
end

local seconds = math.clamp(tonumber(ARGS.seconds) or 2, 0, 60)
local dt = math.clamp(tonumber(ARGS.dt) or 0.5, 0.01, 0.5)
local maxParts = math.floor(math.clamp(tonumber(ARGS.max_parts) or 200, 1, 2000))
local roots = ARGS.paths
if type(roots) ~= "table" or #roots == 0 then
	roots = { "Workspace" }
end

local parts: { BasePart } = {}
local seen: { [Instance]: boolean } = {}
local missing = {}
local function consider(inst: Instance)
	if inst:IsA("BasePart") and not inst.Anchored and not seen[inst] then
		seen[inst] = true
		table.insert(parts, inst)
	end
end
for _, p in ipairs(roots) do
	local inst = S.get(p)
	if inst == nil then
		table.insert(missing, tostring(p))
	else
		consider(inst)
		for _, d in ipairs(inst:GetDescendants()) do
			consider(d)
		end
	end
end

if #parts == 0 then
	return { parts = 0, steps = 0, simulated_s = 0, moved = 0, positions = {}, missing = missing, note = "no unanchored BaseParts under the given paths" }
end

local before: { Vector3 } = {}
for i, part in ipairs(parts) do
	before[i] = part.Position
end

local steps = math.max(1, math.ceil(seconds / dt))
-- One StepPhysics per frame: the steps are wall-clock frames and must fit the request deadline,
-- or the dispatcher cancels the run at timeout_ms and the recording rolls every position back.
local FRAME_S = 1 / 60
local MARGIN_S = 2
local remaining = S.remaining()
if remaining ~= math.huge and steps * FRAME_S + MARGIN_S > remaining then
	local affordable = math.max(1, math.floor((remaining - MARGIN_S) / FRAME_S))
	local minDt = math.min(0.5, math.ceil((seconds / affordable) * 1000) / 1000)
	error(
		(
			"settle_physics: %d steps (seconds=%s / dt=%s) need about %d s of frames but only %.1f s remain before this run's timeout_ms; "
			.. "raise timeout_ms to at least %d, use dt >= %s (%d steps), or split the settle into several calls"
		):format(steps, tostring(seconds), tostring(dt), math.ceil(steps * FRAME_S + MARGIN_S), remaining, math.ceil((steps * FRAME_S + MARGIN_S) * 1000) + 5000, tostring(minDt), math.ceil(seconds / minDt)),
		0
	)
end
for i = 1, steps do
	local ok, err = pcall(function()
		workspace:StepPhysics(dt, parts :: any)
	end)
	if not ok then
		error(("StepPhysics failed at step %d/%d: %s"):format(i, steps, tostring(err)), 0)
	end
	if i < steps then
		task.wait() -- the engine takes one StepPhysics per frame
	end
	S.yield()
end

local positions = {}
local moved, maxMove = 0, 0
for i, part in ipairs(parts) do
	local delta = (part.Position - before[i]).Magnitude
	if delta > 0.01 then
		moved += 1
	end
	if delta > maxMove then
		maxMove = delta
	end
	if i <= maxParts then
		table.insert(positions, { path = S.path(part), position = part.Position, moved = math.round(delta * 100) / 100 })
	end
end

return {
	parts = #parts,
	steps = steps,
	simulated_s = steps * dt,
	moved = moved,
	max_move = math.round(maxMove * 100) / 100,
	positions = positions,
	truncated = #parts > maxParts,
	missing = missing,
}
