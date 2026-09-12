--[[
	In-memory persisted-controller registry (§4.3 `install` with persist = true).

	The durable copy lives in the BRIDGE (per session and in <home>/persist/<placeId>.json):
	plugin:GetSetting returns nil for every key in Studio 0.738, so nothing can be kept in
	plugin settings. Whenever the hub connects (hello — including after a bundle push / runtime
	restart) the bridge sends `persist_sync {controllers: [{dm, name, code}]}`, which REPLACES
	this list. Between syncs the hub keeps it current from the installs / uninstalls it relayed
	(`remember` / `forget`), so a peer hello re-installs the right set (hub/playtest.luau).
]]

local Persist = {}
Persist.__index = Persist

local SOURCE = "bridge"

export type Entry = { dm: string, name: string, code: string, persist: boolean, at: number }

export type Persist = typeof(setmetatable(
	{} :: {
		entries: { Entry }, -- oldest first
		warn: (string) -> (),
		-- Number of persist_sync frames applied and of entries they rejected (malformed).
		syncs: number,
		rejected: number,
	},
	Persist
))

-- "client" means the first client; entries are keyed by the exact peer dm.
function Persist.normaliseDm(dm: string): string
	if dm == "client" then
		return "client:1"
	end
	return dm
end

local function validEntry(v: any): Entry?
	if type(v) ~= "table" or type(v.dm) ~= "string" or type(v.name) ~= "string" or type(v.code) ~= "string" then
		return nil
	end
	local dm = Persist.normaliseDm(v.dm)
	if dm ~= "server" and not string.match(dm, "^client:%d+$") then
		return nil
	end
	if v.name == "" or #v.name > 64 then
		return nil
	end
	return { dm = dm, name = v.name, code = v.code, persist = true, at = if type(v.at) == "number" then v.at else os.time() }
end

function Persist.new(warn: ((string) -> ())?): Persist
	local self = setmetatable({
		entries = {},
		warn = warn or function() end,
		syncs = 0,
		rejected = 0,
	}, Persist)
	return self
end

function Persist.forgetEntry(self: Persist, dm: string, name: string): boolean
	dm = Persist.normaliseDm(dm)
	for i, e in ipairs(self.entries) do
		if e.dm == dm and e.name == name then
			table.remove(self.entries, i)
			return true
		end
	end
	return false
end

-- Stores (or replaces) an entry; the latest install goes to the end.
function Persist.remember(self: Persist, dm: string, name: string, code: string)
	self:forgetEntry(dm, name)
	table.insert(self.entries, { dm = Persist.normaliseDm(dm), name = name, code = code, persist = true, at = os.time() })
end

function Persist.forget(self: Persist, dm: string, name: string): boolean
	return self:forgetEntry(dm, name)
end

-- `persist_sync`: the bridge's list replaces everything held here. Returns the number of entries
-- accepted and the number rejected as malformed (those are reported through `warn`).
function Persist.replaceAll(self: Persist, list: { any }): (number, number)
	local entries: { Entry } = {}
	local rejected = 0
	for _, v in ipairs(list) do
		local entry = validEntry(v)
		if entry then
			-- Later entries win over earlier ones with the same dm + name.
			for i, e in ipairs(entries) do
				if e.dm == entry.dm and e.name == entry.name then
					table.remove(entries, i)
					break
				end
			end
			table.insert(entries, entry)
		else
			rejected += 1
		end
	end
	self.entries = entries
	self.syncs += 1
	self.rejected += rejected
	if rejected > 0 then
		self.warn(("persist_sync: %d malformed controller entr%s ignored"):format(rejected, if rejected == 1 then "y" else "ies"))
	end
	return #entries, rejected
end

-- Entries for one DM, oldest install first.
function Persist.forDm(self: Persist, dm: string): { Entry }
	dm = Persist.normaliseDm(dm)
	local out = {}
	for _, e in ipairs(self.entries) do
		if e.dm == dm then
			table.insert(out, e)
		end
	end
	return out
end

function Persist.get(self: Persist, dm: string, name: string): Entry?
	dm = Persist.normaliseDm(dm)
	for _, e in ipairs(self.entries) do
		if e.dm == dm and e.name == name then
			return e
		end
	end
	return nil
end

-- `playtest status` / `list` → persisted: what the hub will re-install, and where it comes from.
function Persist.list(self: Persist): { { [string]: any } }
	local out = {}
	for _, e in ipairs(self.entries) do
		table.insert(out, { dm = e.dm, name = e.name, bytes = #e.code, persist = true, source = SOURCE })
	end
	return out
end

function Persist.count(self: Persist): number
	return #self.entries
end

function Persist.clear(self: Persist)
	self.entries = {}
end

return Persist
