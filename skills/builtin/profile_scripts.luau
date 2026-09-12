--[[ studio-live skill
name: profile_scripts
description: Any DM: samples ScriptProfilerService for ARGS.seconds (ServerStart on edit/server, ClientStart on a client) and returns the top ARGS.top functions by total time. Feature-detected: returns supported=false with a reason instead of failing.
params: {"seconds":{"type":"number","default":2,"minimum":0.1,"maximum":30},"frequency":{"type":"integer","default":1000,"description":"samples per second, 1-10000"},"top":{"type":"integer","default":20,"maximum":100},"include_native":{"type":"boolean","default":false,"description":"keep engine (native) functions"},"include_plugin":{"type":"boolean","default":false,"description":"keep plugin functions (this runtime included)"},"filter":{"type":"string","description":"keep functions whose name or source contains this (case-insensitive)"}}
]]
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

local seconds = math.clamp(tonumber(ARGS.seconds) or 2, 0.1, 30)
local frequency = math.floor(math.clamp(tonumber(ARGS.frequency) or 1000, 1, 10000))
local top = math.floor(math.clamp(tonumber(ARGS.top) or 20, 1, 100))
local includeNative = ARGS.include_native == true
local includePlugin = ARGS.include_plugin == true
local filter = if type(ARGS.filter) == "string" and ARGS.filter ~= "" then string.lower(ARGS.filter) else nil

local okSvc, profiler = pcall(game.GetService, game, "ScriptProfilerService")
if not okSvc or typeof(profiler) ~= "Instance" then
	return { supported = false, dm = S.dm, reason = "ScriptProfilerService is not available: " .. tostring(profiler) }
end
local svc = profiler :: any

local isClient = S.role == "client"
local player: Player? = nil
if isClient then
	player = Players.LocalPlayer
	if player == nil then
		return { supported = false, dm = S.dm, reason = "no LocalPlayer on this client yet" }
	end
end

local rawJson: string? = nil
local okConn, conn = pcall(function()
	return svc.OnNewData:Connect(function(_who: Player?, json: string)
		if rawJson == nil then
			rawJson = json
		end
	end)
end)
if not okConn then
	return { supported = false, dm = S.dm, reason = "ScriptProfilerService.OnNewData unavailable: " .. tostring(conn) }
end

local okStart, startErr = pcall(function()
	if isClient then
		svc:ClientStart(player, frequency)
	else
		svc:ServerStart(frequency)
	end
end)
if not okStart then
	conn:Disconnect()
	return { supported = false, dm = S.dm, reason = ("%s refused: %s"):format(if isClient then "ClientStart" else "ServerStart", tostring(startErr)) }
end

S.wait(seconds)

local okStop, stopErr = pcall(function()
	if isClient then
		svc:ClientStop(player)
		svc:ClientRequestData(player)
	else
		svc:ServerStop()
		svc:ServerRequestData()
	end
end)
if not okStop then
	conn:Disconnect()
	return { supported = false, dm = S.dm, reason = "stop/request failed: " .. tostring(stopErr) }
end

local deadline = os.clock() + 5
while rawJson == nil and os.clock() < deadline do
	task.wait(0.05)
end
conn:Disconnect()
if rawJson == nil then
	return { supported = false, dm = S.dm, reason = "no OnNewData within 5 s of requesting the profile (the profiler may be edit-mode gated on this build)" }
end
local json = rawJson :: string

local okDecode, profile = pcall(function()
	return svc:DeserializeJSON(json)
end)
if not okDecode or type(profile) ~= "table" then
	okDecode, profile = pcall(HttpService.JSONDecode, HttpService, json)
end
if not okDecode or type(profile) ~= "table" then
	return { supported = false, dm = S.dm, reason = "profile data could not be decoded: " .. tostring(profile), json_bytes = #json }
end

-- profile.Functions[i] = { Name, Source, Line, Flags (1 = native, 2 = plugin), TotalDuration (µs) }
local funcs = if type(profile.Functions) == "table" then profile.Functions else {}
local rows = {}
local omitted = { native = 0, plugin = 0, filtered = 0 }
for i, f in ipairs(funcs) do
	if type(f) == "table" then
		local flags = if type(f.Flags) == "number" then f.Flags else 0
		local native = bit32.band(flags, 1) ~= 0
		local fromPlugin = bit32.band(flags, 2) ~= 0 or (type(f.Source) == "string" and string.find(f.Source, "StudioLive", 1, true) ~= nil)
		local name = if type(f.Name) == "string" and f.Name ~= "" then f.Name else if type(f.Source) == "string" and f.Source ~= "" then f.Source else "<anonymous>"
		local source = if type(f.Source) == "string" then f.Source else nil
		local keep = true
		if native and not includeNative then
			omitted.native += 1
			keep = false
		elseif fromPlugin and not includePlugin then
			omitted.plugin += 1
			keep = false
		elseif filter and not string.find(string.lower(name .. " " .. (source or "")), filter, 1, true) then
			omitted.filtered += 1
			keep = false
		end
		if keep then
			table.insert(rows, {
				index = i,
				name = name,
				source = source,
				line = if type(f.Line) == "number" and f.Line > 0 then f.Line else nil,
				total_us = if type(f.TotalDuration) == "number" then f.TotalDuration else 0,
				native = if native then true else nil,
				plugin = if fromPlugin then true else nil,
			})
		end
	end
	if i % 256 == 0 then
		S.yield()
	end
end
table.sort(rows, function(a, b)
	return a.total_us > b.total_us
end)

local captureUs = seconds * 1e6
local functions = {}
for rank = 1, math.min(top, #rows) do
	local row = rows[rank]
	row.rank = rank
	row.total_us = math.floor(row.total_us + 0.5)
	row.pct = math.floor(row.total_us / captureUs * 10000 + 0.5) / 100
	table.insert(functions, row)
end

return {
	supported = true,
	dm = S.dm,
	seconds = seconds,
	frequency = frequency,
	functions = functions,
	counts = {
		functions = #funcs,
		kept = #rows,
		nodes = if type(profile.Nodes) == "table" then #profile.Nodes else nil,
		categories = if type(profile.Categories) == "table" then #profile.Categories else nil,
	},
	omitted = omitted,
	json_bytes = #json,
}
