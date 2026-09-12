--[[ studio-live skill
name: device_sim
description: Edit DM: Studio device simulator control (StudioDeviceSimulatorService, falling back to StudioDeviceEmulatorService): ARGS.action status|list|set|reset; set takes device (id or name substring), orientation and resolution {w,h}. Every call is feature-detected and pcall'd; unsupported calls are reported, never thrown.
params: {"action":{"type":"string","enum":["status","list","set","reset"],"default":"status"},"device":{"type":"string","description":"set: a device id, or a case-insensitive substring of an id/name from action list"},"orientation":{"type":"string","enum":["LandscapeLeft","LandscapeRight","Portrait","LandscapeSensor","Sensor"],"description":"set: Enum.ScreenOrientation name"},"resolution":{"type":"object","properties":{"w":{"type":"integer"},"h":{"type":"integer"}},"description":"set: viewport resolution in pixels (simulator backend only)"}}
]]
if S.role ~= "edit" then
	error("device_sim runs in the edit DM (dm='edit'): the device simulator belongs to the Studio window", 0)
end

local action = tostring(ARGS.action or "status")
local unsupported: { string } = {}

local function getService(name: string): Instance?
	local ok, svc = pcall(game.GetService, game, name)
	if ok and typeof(svc) == "Instance" then
		return svc
	end
	return nil
end

-- Calls a method by name inside pcall; a missing method or a refused call lands in `unsupported`.
local function call(obj: Instance, method: string, ...: any): any
	local args = table.pack(...)
	local ok, result = pcall(function()
		return (obj :: any)[method](obj, table.unpack(args, 1, args.n))
	end)
	if not ok then
		table.insert(unsupported, ("%s: %s"):format(method, tostring(result)))
		return nil
	end
	return result
end

local function orientationEnum(name: any): EnumItem?
	if name == nil then
		return nil
	end
	local ok, item = pcall(function()
		return (Enum.ScreenOrientation :: any)[tostring(name)]
	end)
	if ok and typeof(item) == "EnumItem" then
		return item
	end
	error(("unknown orientation '%s' (LandscapeLeft|LandscapeRight|Portrait|LandscapeSensor|Sensor)"):format(tostring(name)), 0)
end

local sim = getService("StudioDeviceSimulatorService")
local emu = getService("StudioDeviceEmulatorService")
if sim == nil and emu == nil then
	return { supported = false, backend = nil, reason = "neither StudioDeviceSimulatorService nor StudioDeviceEmulatorService exists in this Studio build" }
end

-- Device list entries are opaque (strings or tables); read ids/names defensively.
local function itemId(item: any): string?
	if type(item) == "string" then
		return item
	elseif type(item) == "table" then
		local id = item.Id or item.id or item.DeviceId or item.deviceId or item.Name or item.name
		return if id ~= nil then tostring(id) else nil
	end
	return nil
end
local function itemText(item: any): string
	if type(item) == "table" then
		return ("%s %s"):format(tostring(item.Name or item.name or ""), tostring(item.Id or item.id or item.DeviceId or ""))
	end
	return tostring(item)
end

local function deviceList(): { any }
	if sim then
		local list = call(sim, "GetDeviceListAsync")
		return if type(list) == "table" then list else {}
	end
	return {}
end

local function resolveDevice(wanted: string): string
	if sim then
		local list = deviceList()
		local lower = string.lower(wanted)
		for _, item in ipairs(list) do
			if itemId(item) == wanted then
				return wanted
			end
		end
		for _, item in ipairs(list) do
			if string.find(string.lower(itemText(item)), lower, 1, true) then
				local id = itemId(item)
				if id then
					return id
				end
			end
		end
		return wanted -- let SetDeviceAsync decide; its error is reported as unsupported
	end
	return wanted
end

local function status(): { [string]: any }
	if sim then
		local resolution = call(sim, "GetResolutionAsync")
		return {
			device = call(sim, "GetDeviceAsync"),
			orientation = tostring(call(sim, "GetOrientationAsync")),
			resolution = if typeof(resolution) == "Vector2" then { w = resolution.X, h = resolution.Y } else resolution,
			pixelDensity = call(sim, "GetPixelDensityAsync"),
			scalingMode = tostring(call(sim, "GetScalingModeAsync")),
		}
	end
	local e = emu :: Instance
	return {
		device = call(e, "GetCurrentDeviceId"),
		orientation = tostring(call(e, "GetCurrentOrientation")),
	}
end

local backend = if sim then "simulator" else "emulator"
local result: { [string]: any } = { supported = true, backend = backend, action = action }

if action == "status" then
	result.status = status()
elseif action == "list" then
	if sim then
		local list = deviceList()
		local devices = {}
		for i, item in ipairs(list) do
			if i > 200 then
				break
			end
			table.insert(devices, if type(item) == "table" then item else { id = tostring(item) })
		end
		result.devices = devices
		result.count = #list
	else
		table.insert(unsupported, "list: StudioDeviceEmulatorService has no device list; use HasDeviceWithId via set")
	end
	result.status = status()
elseif action == "set" then
	local applied = {}
	if ARGS.device ~= nil then
		local wanted = tostring(ARGS.device)
		if sim then
			local id = resolveDevice(wanted)
			call(sim, "SetDeviceAsync", id)
			applied.device = id
		else
			local e = emu :: Instance
			local has = call(e, "HasDeviceWithId", wanted)
			if has == false then
				error(("no emulator device with id '%s'"):format(wanted), 0)
			end
			call(e, "SetCurrentDeviceId", wanted)
			applied.device = wanted
		end
	end
	local orientation = orientationEnum(ARGS.orientation)
	if orientation then
		call(if sim then sim else emu :: Instance, if sim then "SetOrientationAsync" else "SetCurrentOrientation", orientation)
		applied.orientation = tostring(orientation)
	end
	if type(ARGS.resolution) == "table" then
		local w, h = tonumber(ARGS.resolution.w), tonumber(ARGS.resolution.h)
		if w == nil or h == nil then
			error("resolution must be {w, h}", 0)
		end
		if sim then
			call(sim, "SetResolutionAsync", math.floor(w), math.floor(h))
			applied.resolution = { w = math.floor(w), h = math.floor(h) }
		else
			table.insert(unsupported, "resolution: StudioDeviceEmulatorService cannot set a resolution")
		end
	end
	if next(applied) == nil then
		error("set needs at least one of device, orientation, resolution", 0)
	end
	task.wait() -- let the simulator apply before reading back
	result.applied = applied
	result.status = status()
elseif action == "reset" then
	if sim then
		call(sim, "StopSimulationAsync")
	else
		table.insert(unsupported, "reset: StudioDeviceEmulatorService has no stop; set device/orientation explicitly")
	end
	task.wait()
	result.status = status()
else
	error(("unknown action '%s' (status|list|set|reset)"):format(action), 0)
end

if #unsupported > 0 then
	result.unsupported = unsupported
end
return result
