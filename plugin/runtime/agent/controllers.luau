--[[
	Controllers (§4.3 install/uninstall/list, ctx per §6.4).

	A controller is a fresh ModuleScript per install returning { load(ctx), unload() }.
	Every connection / timer created through ctx is tracked and torn down on unload.
	`ctx.storage` survives reinstalls of the same name within this DM.
]]

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local observe = require(script.Parent.Parent.shared.observe)
local runner = require(script.Parent.Parent.shared.runner)
local serialize = require(script.Parent.Parent.shared.serialize)
local types = require(script.Parent.Parent.shared.types)
local util = require(script.Parent.Parent.shared.util)

type Env = types.Env

local Controllers = {}
Controllers.__index = Controllers

local MAX_CALLBACK_ERRORS = 25

type Entry = {
	name: string,
	module: ModuleScript,
	api: { load: (any) -> (), unload: () -> () },
	connections: { RBXScriptConnection },
	threads: { thread },
	errors: number,
	installedAt: number,
	persist: boolean,
	state: string,
}

export type Controllers = typeof(setmetatable(
	{} :: {
		env: Env,
		makeS: () -> any,
		input: any?,
		registry: { [string]: Entry },
		storage: { [string]: { [any]: any } },
	},
	Controllers
))

function Controllers.new(env: Env, makeS: () -> any, input: any?): Controllers
	return setmetatable({ env = env, makeS = makeS, input = input, registry = {}, storage = {} }, Controllers)
end

function Controllers.buildCtx(self: Controllers, entry: Entry): { [string]: any }
	local env = self.env
	local S = self.makeS()
	local ctx: { [string]: any } = { S = S, role = env.role, dm = env.dm, name = entry.name }
	ctx.storage = self.storage[entry.name]

	-- Wraps controller callbacks: an error becomes an `error` event, never a broken loop.
	local function guard(fn: (...any) -> ()): (...any) -> ()
		return function(...)
			local ok, err = xpcall(fn, function(e)
				return { msg = tostring(e), stack = debug.traceback("", 2) }
			end, ...)
			if not ok then
				entry.errors += 1
				env.emit({ type = "error", msg = util.truncate(err.msg, 1024), stack = util.truncate(err.stack, 1024), controller = entry.name })
				if entry.errors >= MAX_CALLBACK_ERRORS and entry.state == "installed" then
					task.defer(function()
						self:unload(entry, "error", ("auto-unloaded after %d callback errors"):format(entry.errors))
					end)
				end
			end
		end
	end

	function ctx.assert(name: string, cond: any, detail: string?): any
		env.emit({ type = "assert", name = tostring(name), ok = cond and true or false, detail = if detail then util.truncate(tostring(detail), 1024) else nil, controller = entry.name })
		return cond
	end
	function ctx.milestone(name: string, data: any?)
		env.emit({ type = "milestone", name = tostring(name), data = serialize.value(data, { maxDepth = 4 }), controller = entry.name })
	end
	function ctx.emit(name: string, data: any?)
		env.emit({ type = "custom", name = tostring(name), data = serialize.value(data, { maxDepth = 4 }), controller = entry.name })
	end
	function ctx.log(...: any)
		env.emit({ type = "log", level = "info", msg = util.truncate(util.formatArgs(...), 2048), controller = entry.name })
	end
	function ctx.onHeartbeat(fn: (number) -> ()): RBXScriptConnection
		local conn = RunService.Heartbeat:Connect(guard(fn))
		table.insert(entry.connections, conn)
		return conn
	end
	function ctx.onEvent(signal: RBXScriptSignal, fn: (...any) -> ()): RBXScriptConnection
		local conn = signal:Connect(guard(fn))
		table.insert(entry.connections, conn)
		return conn
	end
	function ctx.every(seconds: number, fn: () -> ()): thread
		local guarded = guard(fn)
		local thread = task.spawn(function()
			while true do
				task.wait(math.max(0.016, tonumber(seconds) or 1))
				guarded()
			end
		end)
		table.insert(entry.threads, thread)
		return thread
	end
	function ctx.after(seconds: number, fn: () -> ()): thread
		local thread = task.delay(math.max(0, tonumber(seconds) or 0), guard(fn))
		table.insert(entry.threads, thread)
		return thread
	end
	ctx.player = if env.role == "client" then Players.LocalPlayer else nil
	ctx.character = S.character
	ctx.moveTo = S.moveTo
	ctx.pathTo = S.pathTo
	ctx.input = if self.input and env.role == "client" then self.input:api() else nil
	function ctx.state(): { [string]: any }
		return observe.player(env)
	end
	return ctx
end

function Controllers.unload(self: Controllers, entry: Entry, state: string, detail: string?)
	if self.registry[entry.name] ~= entry then
		return
	end
	self.registry[entry.name] = nil
	entry.state = state
	local ok, err = pcall(entry.api.unload)
	for _, c in ipairs(entry.connections) do
		pcall(c.Disconnect, c)
	end
	for _, t in ipairs(entry.threads) do
		pcall(task.cancel, t)
	end
	entry.connections, entry.threads = {}, {}
	entry.module:Destroy()
	local ev: { [string]: any } = { type = "controller", name = entry.name, state = state, detail = detail }
	if not ok then
		ev.state = "error"
		ev.detail = ("unload() failed: %s"):format(tostring(err))
	end
	self.env.emit(ev)
end

-- `install`: returns { installed, replaced, persist }. `ctl` (when the install runs as a request)
-- lets a hard cancel release the diagnostics listener used while requiring the module.
function Controllers.install(self: Controllers, body: { [string]: any }, ctl: types.Control?): { [string]: any }
	local name = body.name
	if type(name) ~= "string" or name == "" or #name > 64 then
		error(util.perr("bad_request", "install: 'name' must be a 1-64 char string"), 0)
	end
	if type(body.code) ~= "string" then
		error(util.perr("bad_request", "install: 'code' must be a string"), 0)
	end
	local replaced = false
	local previous = self.registry[name]
	if previous then
		self:unload(previous, "unloaded", "replaced")
		replaced = true
	end
	if self.storage[name] == nil then
		self.storage[name] = {}
	end
	local module = Instance.new("ModuleScript")
	module.Name = "StudioLiveController_" .. name
	module.Source = body.code
	local ok, result = runner.requireWithDiagnostics(module, 0, ctl)
	if not ok then
		module:Destroy()
		error(util.perr("luau_error", ("install %s: %s"):format(name, tostring(result))), 0)
	end
	if type(result) ~= "table" or type(result.load) ~= "function" or type(result.unload) ~= "function" then
		module:Destroy()
		error(util.perr("bad_request", ("install %s: code must return { load = function(ctx) end, unload = function() end }"):format(name)), 0)
	end
	local entry: Entry = {
		name = name,
		module = module,
		api = result,
		connections = {},
		threads = {},
		errors = 0,
		installedAt = os.clock(),
		persist = body.persist == true,
		state = "installed",
	}
	local ctx = self:buildCtx(entry)
	local loadOk, loadErr = xpcall(entry.api.load, function(e)
		return { msg = tostring(e), stack = debug.traceback("", 2) }
	end, ctx)
	if not loadOk then
		for _, c in ipairs(entry.connections) do
			pcall(c.Disconnect, c)
		end
		for _, t in ipairs(entry.threads) do
			pcall(task.cancel, t)
		end
		module:Destroy()
		self.env.emit({ type = "controller", name = name, state = "error", detail = util.truncate(loadErr.msg, 1024) })
		error(util.perr("luau_error", ("install %s: load() failed: %s"):format(name, loadErr.msg), { stack = loadErr.stack }), 0)
	end
	self.registry[name] = entry
	self.env.emit({ type = "controller", name = name, state = "installed", detail = if replaced then "replaced" else nil })
	return { installed = name, replaced = replaced, persist = entry.persist }
end

function Controllers.uninstall(self: Controllers, body: { [string]: any }): { [string]: any }
	local name = body.name
	local entry = if type(name) == "string" then self.registry[name] else nil
	if entry == nil then
		error(util.perr("bad_request", ("uninstall: no controller named '%s'"):format(tostring(name))), 0)
	end
	self:unload(entry, "unloaded", "uninstalled")
	return { uninstalled = name }
end

function Controllers.list(self: Controllers): { { [string]: any } }
	local out = {}
	for name, entry in pairs(self.registry) do
		table.insert(out, {
			dm = self.env.dm,
			name = name,
			state = entry.state,
			persist = entry.persist,
			uptime_s = util.round(os.clock() - entry.installedAt, 1),
			errors = entry.errors,
		})
	end
	table.sort(out, function(a, b)
		return a.name < b.name
	end)
	return out
end

function Controllers.unloadAll(self: Controllers)
	for _, entry in pairs(self.registry) do
		self:unload(entry, "unloaded", "runtime stopping")
	end
end

return Controllers
