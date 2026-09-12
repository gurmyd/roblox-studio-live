--[[ studio-live skill
name: insert_asset
description: Edit DM: InsertService:LoadAsset(ARGS.assetId) parented under ARGS.parent (default Workspace); the loader's wrapper Model is unwrapped when it holds a single child unless ARGS.unpack is false. Returns the inserted paths; one undo step. Fails with the engine's message when the asset is private or missing.
params: {"assetId":{"type":"integer","description":"library/catalog asset id (required)"},"parent":{"type":"string","default":"Workspace"},"unpack":{"type":"boolean","default":true,"description":"move the asset's single child out of the wrapper Model"},"name":{"type":"string","description":"rename the inserted instance"},"position":{"type":"array","items":{"type":"number"},"description":"[x, y, z]: pivot the inserted model/part here"}}
]]
local InsertService = game:GetService("InsertService")

if S.role ~= "edit" then
	error("insert_asset runs in the edit DM (dm='edit'); use run with dm='server' and InsertService there for a live test", 0)
end

local assetId = math.floor(tonumber(ARGS.assetId) or 0)
if assetId <= 0 then
	error("ARGS.assetId must be a positive integer asset id", 0)
end
local parent = S.get(ARGS.parent or "Workspace")
if parent == nil then
	error(("no instance at parent path '%s'"):format(tostring(ARGS.parent)), 0)
end

local okLoad, loaded = pcall(InsertService.LoadAsset, InsertService, assetId)
if not okLoad then
	error(("InsertService:LoadAsset(%d) failed: %s"):format(assetId, tostring(loaded)), 0)
end
if typeof(loaded) ~= "Instance" then
	error(("InsertService:LoadAsset(%d) returned %s"):format(assetId, typeof(loaded)), 0)
end
local model = loaded :: Instance

local inserted: Instance
local unpacked = false
local children = model:GetChildren()
if ARGS.unpack ~= false and #children == 1 then
	inserted = children[1]
	inserted.Parent = parent
	model:Destroy()
	unpacked = true
else
	inserted = model
	inserted.Parent = parent
end

if type(ARGS.name) == "string" and ARGS.name ~= "" then
	inserted.Name = ARGS.name
end
if type(ARGS.position) == "table" then
	local p = ARGS.position
	local pos = Vector3.new(tonumber(p[1]) or 0, tonumber(p[2]) or 0, tonumber(p[3]) or 0)
	if inserted:IsA("Model") then
		inserted:PivotTo(CFrame.new(pos))
	elseif inserted:IsA("BasePart") then
		inserted.Position = pos
	end
end

local top = {}
for i, child in ipairs(inserted:GetChildren()) do
	if i > 20 then
		break
	end
	table.insert(top, { name = child.Name, class = child.ClassName })
end

return {
	assetId = assetId,
	path = S.path(inserted),
	class = inserted.ClassName,
	name = inserted.Name,
	descendants = #inserted:GetDescendants(),
	children = top,
	unpacked = unpacked,
}
