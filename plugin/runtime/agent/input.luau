--[[
	`input` (§4.4) on the play-client DM via UserInputService:CreateVirtualInput().

	Coordinates: with `gui` (default true) the GuiInset is added, so callers pass
	GUI-space coordinates (AbsolutePosition space); `gui=false` sends raw viewport
	coordinates as reported by UserInputService:GetMouseLocation(). See protocol Notes.

	Keys and mouse buttons that are down are tracked so an aborted sequence (deadline,
	cancel, abort_on_error) never leaves the character running into a wall.

	The measured VirtualInput (live-measurements.md §5) exposes SendKey, SendMouseButton
	and SendTextInput only; mouse movement methods are probed at call time and `look` is
	verified against the camera, so a step that had no effect reports ok=false.
]]

local GuiService = game:GetService("GuiService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local paths = require(script.Parent.Parent.shared.paths)
local types = require(script.Parent.Parent.shared.types)
local util = require(script.Parent.Parent.shared.util)

type Control = types.Control

local Input = {}
Input.__index = Input

type HeldButton = { pos: Vector2, btn: Enum.UserInputType }

export type Input = typeof(setmetatable(
	{} :: { vi: any?, role: string, heldKeys: { [Enum.KeyCode]: boolean }, heldButtons: { [Enum.UserInputType]: HeldButton } },
	Input
))

local KEY_ALIASES: { [string]: string } = {
	space = "Space",
	enter = "Return",
	["return"] = "Return",
	esc = "Escape",
	escape = "Escape",
	shift = "LeftShift",
	ctrl = "LeftControl",
	control = "LeftControl",
	alt = "LeftAlt",
	tab = "Tab",
	backspace = "BackSpace",
	up = "Up",
	down = "Down",
	left = "Left",
	right = "Right",
	["0"] = "Zero",
	["1"] = "One",
	["2"] = "Two",
	["3"] = "Three",
	["4"] = "Four",
	["5"] = "Five",
	["6"] = "Six",
	["7"] = "Seven",
	["8"] = "Eight",
	["9"] = "Nine",
}

local BUTTONS: { [string]: Enum.UserInputType } = {
	left = Enum.UserInputType.MouseButton1,
	right = Enum.UserInputType.MouseButton2,
	middle = Enum.UserInputType.MouseButton3,
}

-- Yielded-away time is capped so a hold never outlives the request's deadline.
local HOLD_MARGIN_S = 0.05

local function resolveKey(key: any): Enum.KeyCode
	if typeof(key) == "EnumItem" then
		return key :: Enum.KeyCode
	end
	local name = tostring(key)
	local candidates = { name, KEY_ALIASES[string.lower(name)], string.upper(name), string.upper(string.sub(name, 1, 1)) .. string.sub(name, 2) }
	for _, c in ipairs(candidates) do
		if c then
			local ok, item = pcall(function()
				return (Enum.KeyCode :: any)[c]
			end)
			if ok and typeof(item) == "EnumItem" then
				return item :: Enum.KeyCode
			end
		end
	end
	error(("unknown key '%s'"):format(name), 0)
end

function Input.new(role: string): Input
	return setmetatable({ vi = nil, role = role, heldKeys = {}, heldButtons = {} }, Input)
end

function Input.available(self: Input): boolean
	if self.role ~= "client" then
		return false
	end
	return self:vinput(false) ~= nil
end

-- Lazily creates (and caches) the VirtualInput object.
function Input.vinput(self: Input, must: boolean): any
	if self.vi == nil then
		local ok, obj = pcall(UserInputService.CreateVirtualInput, UserInputService)
		if ok and obj ~= nil then
			self.vi = obj
		end
	end
	if self.vi == nil and must then
		error(util.perr("unsupported", "UserInputService:CreateVirtualInput() is unavailable in this DM"), 0)
	end
	return self.vi
end

-- VirtualInput methods beyond the measured three may not exist on a given build. Throws a plain
-- string: step errors are reported as text per step, not as protocol errors.
local function method(vi: any, name: string): any
	local ok, fn = pcall(function()
		return vi[name]
	end)
	if ok and type(fn) == "function" then
		return fn
	end
	error(("unsupported: VirtualInput has no %s on this Studio build"):format(name), 0)
end

local function screenPoint(x: any, y: any, gui: boolean): Vector2
	local px, py = tonumber(x) or 0, tonumber(y) or 0
	if gui then
		local inset = GuiService:GetGuiInset()
		return Vector2.new(px + inset.X, py + inset.Y)
	end
	return Vector2.new(px, py)
end

local function holdSeconds(seconds: number, ctl: Control?): number
	if ctl == nil then
		return seconds
	end
	return math.max(0, math.min(seconds, ctl.remaining() - HOLD_MARGIN_S))
end

function Input.key(self: Input, key: any, holdSecs: number?, ctl: Control?)
	local vi = self:vinput(true)
	local kc = resolveKey(key)
	vi:SendKey(true, kc)
	self.heldKeys[kc] = true
	task.wait(holdSeconds(holdSecs or 0.05, ctl))
	vi:SendKey(false, kc)
	self.heldKeys[kc] = nil
end

function Input.edge(self: Input, key: any, down: boolean)
	local kc = resolveKey(key)
	self:vinput(true):SendKey(down, kc)
	if down then
		self.heldKeys[kc] = true
	else
		self.heldKeys[kc] = nil
	end
end

function Input.click(self: Input, x: any, y: any, button: string?, gui: boolean?)
	local vi = self:vinput(true)
	local btn = BUTTONS[string.lower(button or "left")] or Enum.UserInputType.MouseButton1
	local pos = screenPoint(x, y, gui ~= false)
	local okDown, errDown = pcall(vi.SendMouseButton, vi, pos, btn, true)
	if not okDown then
		-- A dropped "up" poisons the next "down": release, then retry once.
		pcall(vi.SendMouseButton, vi, pos, btn, false)
		local okRetry, errRetry = pcall(vi.SendMouseButton, vi, pos, btn, true)
		if not okRetry then
			error(("mouse down failed: %s (retry: %s)"):format(tostring(errDown), tostring(errRetry)), 0)
		end
	end
	self.heldButtons[btn] = { pos = pos, btn = btn }
	task.wait(0.05)
	vi:SendMouseButton(pos, btn, false)
	self.heldButtons[btn] = nil
end

function Input.move(self: Input, x: any, y: any, gui: boolean?)
	local vi = self:vinput(true)
	method(vi, "SendMousePosition")(vi, screenPoint(x, y, gui ~= false))
end

-- Relative look: lock the cursor, let the engine apply the lock (it only takes effect on the
-- next frame — measured live: a delta sent in the same frame errors "cursor is not locked"),
-- send the delta, then check that the camera actually turned. No rotation = a failed step.
function Input.look(self: Input, dx: any, dy: any)
	local vi = self:vinput(true)
	local sendDelta = method(vi, "SendMouseDelta")
	local camera = workspace.CurrentCamera
	local before = if camera then camera.CFrame else nil
	local previous = UserInputService.MouseBehavior
	UserInputService.MouseBehavior = Enum.MouseBehavior.LockCenter
	local ok, err = false, "cursor never locked"
	for _ = 1, 6 do
		RunService.RenderStepped:Wait()
		ok, err = pcall(sendDelta, vi, Vector2.new(tonumber(dx) or 0, tonumber(dy) or 0))
		if ok or not string.find(tostring(err), "not locked", 1, true) then
			break
		end
		UserInputService.MouseBehavior = Enum.MouseBehavior.LockCenter
	end
	RunService.RenderStepped:Wait()
	RunService.RenderStepped:Wait()
	UserInputService.MouseBehavior = previous
	if not ok then
		error(tostring(err), 0)
	end
	if camera and before then
		local after = camera.CFrame
		local turned = (after.LookVector - before.LookVector).Magnitude > 1e-4
		if not turned then
			error("camera did not rotate: the camera script ignores virtual mouse deltas; set workspace.CurrentCamera.CameraType = Scriptable and its CFrame from a run instead", 0)
		end
	end
end

function Input.text(self: Input, text: any)
	self:vinput(true):SendTextInput(tostring(text))
end

function Input.focus(self: Input, path: any)
	if type(path) ~= "string" then
		error("focus: 'path' is required", 0)
	end
	local inst = paths.resolve(path)
	if inst == nil and Players.LocalPlayer then
		inst = paths.resolve(path, Players.LocalPlayer)
	end
	if inst == nil then
		error(("focus: no instance at '%s'"):format(path), 0)
	end
	if not inst:IsA("TextBox") then
		error(("focus: %s is a %s, not a TextBox"):format(path, inst.ClassName), 0)
	end
	inst:CaptureFocus()
end

-- Releases every key / button this object pressed and has not released; returns how many.
function Input.releaseAll(self: Input): number
	local vi = self.vi
	local n = 0
	if vi == nil then
		self.heldKeys, self.heldButtons = {}, {}
		return 0
	end
	for kc in pairs(self.heldKeys) do
		pcall(vi.SendKey, vi, false, kc)
		n += 1
	end
	for _, held in pairs(self.heldButtons) do
		pcall(vi.SendMouseButton, vi, held.pos, held.btn, false)
		n += 1
	end
	self.heldKeys, self.heldButtons = {}, {}
	return n
end

-- Executes one action step; errors are strings (reported per step).
function Input.step(self: Input, a: { [string]: any }, ctl: Control?)
	local t = a.type
	if t == "key" then
		if a.down ~= nil then
			self:edge(a.key, a.down == true)
		else
			self:key(a.key, util.num(a.hold_ms, 50, 0, 60000) / 1000, ctl)
		end
	elseif t == "click" then
		self:click(a.x, a.y, a.button, a.gui)
	elseif t == "move" then
		self:move(a.x, a.y, a.gui)
	elseif t == "look" then
		self:look(a.dx, a.dy)
	elseif t == "text" then
		self:text(a.text or "")
	elseif t == "wait" then
		task.wait(holdSeconds(util.num(a.ms, 100, 0, 60000) / 1000, ctl))
	elseif t == "focus" then
		self:focus(a.path)
	else
		error(("unknown action type '%s'"):format(tostring(t)), 0)
	end
end

-- The `input` op: { actions: [...], abort_on_error? } → { steps, elapsed_ms, released? }.
function Input.run(self: Input, body: { [string]: any }, ctl: Control): { [string]: any }
	if self.role ~= "client" then
		error(util.perr("unsupported", "input is only available on client DMs"), 0)
	end
	local actions = body.actions
	if type(actions) ~= "table" then
		error(util.perr("bad_request", "input: 'actions' must be an array"), 0)
	end
	self:vinput(true)
	-- Deadline / hard cancel kills this thread between a down and its up: let go of everything first.
	ctl.onAbort(function()
		self:releaseAll()
	end)
	local t0 = os.clock()
	local steps = {}
	local aborted = false
	for i, a in ipairs(actions) do
		ctl.checkCancel()
		local ok, err = pcall(function()
			if type(a) ~= "table" then
				error("action must be an object", 0)
			end
			self:step(a, ctl)
		end)
		local step: { [string]: any } = { i = i, ok = ok }
		if not ok then
			step.error = util.truncate(tostring(err), 512)
		end
		table.insert(steps, step)
		if not ok and body.abort_on_error == true then
			aborted = true
			break
		end
	end
	local out: { [string]: any } = { steps = steps, elapsed_ms = util.round((os.clock() - t0) * 1000) }
	if aborted then
		out.released = self:releaseAll()
	end
	return out
end

-- ctx.input for controllers (§6.4): each call returns ok, err instead of throwing.
function Input.api(self: Input): { [string]: any }
	local function wrap(fn: (...any) -> ())
		return function(...)
			local ok, err = pcall(fn, self, ...)
			return ok, if ok then nil else tostring(err)
		end
	end
	return {
		key = wrap(function(s, k, hold)
			s:key(k, hold)
		end),
		press = wrap(function(s, k)
			s:edge(k, true)
		end),
		release = wrap(function(s, k)
			s:edge(k, false)
		end),
		click = wrap(function(s, x, y, button)
			s:click(x, y, button, true)
		end),
		move = wrap(function(s, x, y)
			s:move(x, y, true)
		end),
		look = wrap(function(s, dx, dy)
			s:look(dx, dy)
		end),
		text = wrap(function(s, text)
			s:text(text)
		end),
	}
end

return Input
