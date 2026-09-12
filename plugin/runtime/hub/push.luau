--[[
	`push` (hub): copies edit-DM instances into a live play DM without restarting the test.

	edit DM: resolve paths → SerializationService:SerializeInstancesAsync → Base64 →
	agent op `push_apply` {b64, parent?, parents[], names[], classes[]} → the agent decodes,
	DeserializeInstancesAsync, parents each root and answers {paths, count, bytes}.

	Replication follows the engine's rules: a tree pushed to the server replicates to every
	client; a tree pushed to a client exists in that client only.
]]

local paths = require(script.Parent.Parent.shared.paths)
local types = require(script.Parent.Parent.shared.types)
local util = require(script.Parent.Parent.shared.util)

local Star = require(script.Parent.star)

type Control = types.Control
type Request = types.Request

local Push = {}

local MAX_PATHS = 200
-- Cap on the base64 text sent over L2 (chunked at 16 KB by the star; 4 MB ≈ 260 chunks).
local MAX_B64_BYTES = 4 * 1024 * 1024
-- When two roots share a name the agent cannot tell them apart by name, and DeserializeInstancesAsync
-- is not guaranteed to keep their order: each root carries its index as an attribute for the trip
-- (set on the edit-DM instance only while it is serialised, then removed; the agent strips it too).
local INDEX_ATTRIBUTE = "StudioLivePushIndex"

export type Deps = {
	star: Star.Star,
	request: (dm: string, op: string, body: { [string]: any }, timeoutS: number) -> (boolean, any),
}

local function service(name: string): any?
	local ok, svc = pcall(game.GetService, game, name)
	return if ok then svc else nil
end

-- True when at least two roots share a name (then position/name matching on the agent is ambiguous).
local function hasDuplicateNames(instances: { Instance }): boolean
	local seen: { [string]: boolean } = {}
	for _, inst in ipairs(instances) do
		if seen[inst.Name] then
			return true
		end
		seen[inst.Name] = true
	end
	return false
end

-- Serialises `instances` to base64; returns b64, byte count, milliseconds, and whether the roots were
-- tagged with INDEX_ATTRIBUTE (only when names collide, so the edit DM is normally left untouched).
function Push.encode(instances: { Instance }): (string, number, number, boolean)
	local Serialization = service("SerializationService")
	local Encoding = service("EncodingService")
	if Serialization == nil or Encoding == nil then
		error(util.perr("unsupported", "SerializationService / EncodingService are unavailable in this Studio"), 0)
	end
	local tagged = hasDuplicateNames(instances)
	if tagged then
		for i, inst in ipairs(instances) do
			pcall(inst.SetAttribute, inst, INDEX_ATTRIBUTE, i)
		end
	end
	local t0 = os.clock()
	local ok, buf = pcall(Serialization.SerializeInstancesAsync, Serialization, instances)
	if tagged then
		for _, inst in ipairs(instances) do
			pcall(inst.SetAttribute, inst, INDEX_ATTRIBUTE, nil)
		end
	end
	if not ok or typeof(buf) ~= "buffer" then
		error(util.perr("internal", ("SerializeInstancesAsync failed: %s"):format(tostring(buf))), 0)
	end
	local bytes = buffer.len(buf)
	local okB, b64buf = pcall(Encoding.Base64Encode, Encoding, buf)
	if not okB or typeof(b64buf) ~= "buffer" then
		error(util.perr("internal", ("Base64Encode failed: %s"):format(tostring(b64buf))), 0)
	end
	return buffer.tostring(b64buf), bytes, (os.clock() - t0) * 1000, tagged
end

function Push.handler(deps: Deps): (req: Request, ctl: Control) -> { [string]: any }
	return function(req: Request, ctl: Control)
		local body = req.body
		local list = body.paths
		if type(list) ~= "table" or #list == 0 then
			error(util.perr("bad_request", "push: 'paths' must be a non-empty array of instance paths"), 0)
		end
		if #list > MAX_PATHS then
			error(util.perr("bad_request", ("push: at most %d paths per call"):format(MAX_PATHS)), 0)
		end
		local dm = if type(body.dm) == "string" and body.dm ~= "" then body.dm else "server"
		if dm ~= "server" and dm ~= "client" and not string.match(dm, "^client:%d+$") then
			error(util.perr("bad_request", ("push: 'dm' must be \"server\", \"client\" or \"client:N\", got '%s'"):format(dm)), 0)
		end
		local parentPath: string? = nil
		if body.parent ~= nil then
			if type(body.parent) ~= "string" or body.parent == "" then
				error(util.perr("bad_request", "push: 'parent' must be an instance path"), 0)
			end
			parentPath = body.parent
		end
		local instances: { Instance } = {}
		local parents: { string } = {}
		local names: { string } = {}
		local classes: { string } = {}
		for i, p in ipairs(list) do
			if type(p) ~= "string" then
				error(util.perr("bad_request", ("push: paths[%d] must be a string"):format(i)), 0)
			end
			local inst = paths.resolve(p)
			if inst == nil then
				error(util.perr("bad_request", ("push: no instance at '%s'"):format(p)), 0)
			end
			if inst == game or inst.Parent == game then
				error(util.perr("bad_request", ("push: '%s' is a service; push its children instead"):format(p)), 0)
			end
			local parent = inst.Parent
			if parentPath == nil and parent == nil then
				error(util.perr("bad_request", ("push: '%s' has no parent; pass 'parent'"):format(p)), 0)
			end
			for _, other in ipairs(instances) do
				if other == inst or inst:IsDescendantOf(other) or other:IsDescendantOf(inst) then
					error(util.perr("bad_request", ("push: '%s' overlaps another pushed instance"):format(p)), 0)
				end
			end
			table.insert(instances, inst)
			table.insert(parents, parentPath or paths.of(parent :: Instance))
			table.insert(names, inst.Name)
			table.insert(classes, inst.ClassName)
		end
		local peer = deps.star:get(dm)
		if peer == nil then
			error(util.perr("no_peer", ("push: dm '%s' is not connected"):format(dm)), 0)
		end
		ctl.checkCancel()
		local b64, bytes, serializeMs, tagged = Push.encode(instances)
		if #b64 > MAX_B64_BYTES then
			error(util.perr("bad_request", ("push: serialized tree is %d KB (base64), above the %d KB cap; push fewer instances"):format(#b64 // 1024, MAX_B64_BYTES // 1024)), 0)
		end
		ctl.checkCancel()
		-- replace (default true): the agent removes a same-named child of the target parent first, so
		-- pushing a tree twice updates it instead of stacking copies (live: two "PushProbe" models).
		local replace = body.replace ~= false
		local ok, res = deps.request(peer.dm :: string, "push_apply", {
			b64 = b64,
			parent = parentPath,
			parents = parents,
			names = names,
			classes = classes,
			index_attribute = if tagged then INDEX_ATTRIBUTE else nil,
			replace = replace,
		}, math.max(5, ctl.remaining()))
		if not ok then
			error(res, 0)
		end
		local out = if type(res) == "table" then res else {}
		return {
			dm = peer.dm,
			paths = out.paths or {},
			count = out.count or #instances,
			replaced = if type(out.replaced) == "number" then out.replaced else 0,
			-- Same-named siblings `replace` left alone (other class, Terrain, CurrentCamera, a player character).
			skipped = if type(out.skipped) == "table" and #out.skipped > 0 then out.skipped else nil,
			replace = replace,
			bytes = bytes,
			b64_bytes = #b64,
			serialize_ms = util.round(serializeMs, 1),
			apply_ms = out.apply_ms,
			replicated = peer.dm == "server",
			note = if peer.dm == "server" then "pushed to the server: replicates to every client" else "pushed to a client: local to that client only",
		}
	end
end

return Push
