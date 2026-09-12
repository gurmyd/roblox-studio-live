--[[ studio-live skill
name: lighting_preset
description: Edit DM: applies a Lighting preset (ARGS.preset day|night|dusk: ClockTime, Brightness, Ambient, OutdoorAmbient, ExposureCompensation, GlobalShadows) plus ARGS.overrides (any Lighting property; "#rrggbb" strings become Color3) and returns the previous and new values. One undo step.
params: {"preset":{"type":"string","enum":["day","night","dusk"],"description":"required unless overrides alone are wanted"},"overrides":{"type":"object","description":"extra Lighting properties, e.g. {\"FogEnd\": 500, \"FogColor\": \"#8899aa\"}"}}
]]
local Lighting = game:GetService("Lighting")

if S.role ~= "edit" then
	error("lighting_preset runs in the edit DM (dm='edit'); in a playtest use run with S.set(game.Lighting, {...})", 0)
end

local PRESETS: { [string]: { [string]: any } } = {
	day = {
		ClockTime = 14,
		Brightness = 3,
		Ambient = Color3.fromRGB(70, 70, 70),
		OutdoorAmbient = Color3.fromRGB(128, 128, 128),
		ExposureCompensation = 0,
		GlobalShadows = true,
	},
	night = {
		ClockTime = 0,
		Brightness = 1,
		Ambient = Color3.fromRGB(25, 25, 35),
		OutdoorAmbient = Color3.fromRGB(40, 40, 60),
		ExposureCompensation = 0.25,
		GlobalShadows = true,
	},
	dusk = {
		ClockTime = 17.75,
		Brightness = 2,
		Ambient = Color3.fromRGB(80, 60, 50),
		OutdoorAmbient = Color3.fromRGB(140, 100, 80),
		ExposureCompensation = 0.1,
		GlobalShadows = true,
	},
}

local preset = ARGS.preset
local props: { [string]: any } = {}
if preset ~= nil then
	local values = PRESETS[tostring(preset)]
	if values == nil then
		error(("unknown preset '%s' (day|night|dusk)"):format(tostring(preset)), 0)
	end
	for k, v in pairs(values) do
		props[k] = v
	end
end
if type(ARGS.overrides) == "table" then
	for k, v in pairs(ARGS.overrides) do
		local name = tostring(k)
		-- A hex string targets a Color3 property; anything else is written as given.
		if type(v) == "string" and string.match(v, "^#%x%x%x%x%x%x$") then
			local okRead, current = pcall(function()
				return (Lighting :: any)[name]
			end)
			props[name] = if okRead and typeof(current) == "Color3" then Color3.fromHex(v) else v
		else
			props[name] = v
		end
	end
end
if next(props) == nil then
	error("pass ARGS.preset (day|night|dusk) and/or ARGS.overrides", 0)
end

local before: { [string]: any } = {}
for name in pairs(props) do
	local ok, v = pcall(function()
		return (Lighting :: any)[name]
	end)
	if ok then
		before[name] = v
	end
end

S.set(Lighting, props)

local after: { [string]: any } = {}
for name in pairs(props) do
	local ok, v = pcall(function()
		return (Lighting :: any)[name]
	end)
	if ok then
		after[name] = v
	end
end

return { preset = preset, before = before, after = after }
