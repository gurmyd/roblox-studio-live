--[[
	Compiles and runs agent programs (protocol.md §4.1).

	edit / server DMs: `loadstring` + `setfenv` with S / ARGS / print / warn injected.
	client DM (no loadstring): the code is wrapped as
	    return function(S, ARGS, print, warn) <code> end
	in a fresh ModuleScript and `require`d. A failing require only says "Requested module
	experienced an error while loading"; the real message is printed to LogService one
	frame later, so we capture it there. Line numbers in messages are remapped by the
	number of wrapper lines above the agent's code (the ModuleScript header plus any
	lines the caller prepended, e.g. run_until's `return (`).
]]

local LogService = game:GetService("LogService")

local geometry = require(script.Parent.geometry)
local protocol = require(script.Parent.protocol)
local serialize = require(script.Parent.serialize)
local types = require(script.Parent.types)
local util = require(script.Parent.util)

type Control = types.Control
type OutputEntry = types.OutputEntry

local runner = {}

-- Environment the loadstring'd chunk inherits (Roblox globals); getfenv is deliberate.
local baseEnv = getfenv()

local function probeLoadstring(): boolean
	local ok, fn = pcall(function()
		return (baseEnv :: any).loadstring("return 1")
	end)
	return ok and type(fn) == "function"
end

runner.hasLoadstring = probeLoadstring()

export type Compiled = { fn: (...any) -> ...any, mode: string, module: ModuleScript?, chunkName: string, lineOffset: number }

-- Lines the caller wrapped around the program (0 for a plain `run`); `ctl` lets a hard cancel
-- release the LogService listener used for client-side diagnostics.
export type CompileOptions = { lineOffset: number?, ctl: Control? }

local SYNTAX_MARKERS = { "Expected ", "Incomplete statement", "Malformed ", "Unexpected ", "Unfinished ", "syntax error" }

local function looksLikeSyntaxError(msg: string): boolean
	for _, m in ipairs(SYNTAX_MARKERS) do
		if string.find(msg, m, 1, true) then
			return true
		end
	end
	return false
end

-- Rewrites "<name>:<line>:" so line numbers refer to the agent's code, not the wrapper.
local function remapLines(msg: string, name: string, offset: number): string
	if offset <= 0 then
		return msg
	end
	return (string.gsub(msg, "(" .. name:gsub("%p", "%%%0") .. "):(%d+):", function(prefix, line)
		return ("%s:%d:"):format(prefix, math.max(1, (tonumber(line) or 1) - offset))
	end))
end

-- Requires a fresh module, harvesting the real error text from LogService when it fails.
function runner.requireWithDiagnostics(module: ModuleScript, lineOffset: number, ctl: Control?): (boolean, any)
	local captured: { string } = {}
	local conn = LogService.MessageOut:Connect(function(message: string, messageType: Enum.MessageType)
		if messageType == Enum.MessageType.MessageError then
			table.insert(captured, message)
		end
	end)
	if ctl then
		-- A deadline / hard cancel closes this thread mid-wait; the listener must not outlive it.
		ctl.onAbort(function()
			conn:Disconnect()
		end)
	end
	local ok, result = pcall(require, module)
	if ok then
		conn:Disconnect()
		return true, result
	end
	-- The diagnostic lands on LogService within the next couple of frames.
	for _ = 1, 2 do
		local found = false
		for _, m in ipairs(captured) do
			if string.find(m, module.Name, 1, true) then
				found = true
				break
			end
		end
		if found then
			break
		end
		task.wait()
	end
	conn:Disconnect()
	local message = tostring(result)
	for _, m in ipairs(captured) do
		if string.find(m, module.Name, 1, true) then
			message = m
			break
		end
	end
	if message == tostring(result) and captured[1] ~= nil then
		message = captured[1]
	end
	return false, remapLines(message, module.Name, lineOffset)
end

-- Compiles `code`; on failure returns nil + protocol error.
function runner.compile(code: string, chunkName: string, options: CompileOptions?): (Compiled?, { [string]: any }?)
	local extra = if options and options.lineOffset then options.lineOffset else 0
	if runner.hasLoadstring then
		local fn, err = (baseEnv :: any).loadstring(code, "=" .. chunkName)
		if type(fn) ~= "function" then
			return nil, util.perr("syntax_error", remapLines(tostring(err), chunkName, extra))
		end
		return { fn = fn, mode = "loadstring", chunkName = chunkName, lineOffset = extra }, nil
	end
	local module = Instance.new("ModuleScript")
	module.Name = chunkName
	module.Source = "return function(S, ARGS, print, warn)\n" .. code .. "\nend"
	local offset = 1 + extra
	local ok, result = runner.requireWithDiagnostics(module, offset, if options then options.ctl else nil)
	if not ok then
		module:Destroy()
		local msg = tostring(result)
		return nil, util.perr(if looksLikeSyntaxError(msg) then "syntax_error" else "luau_error", msg)
	end
	if type(result) ~= "function" then
		module:Destroy()
		return nil, util.perr("internal", "program wrapper did not return a function")
	end
	return { fn = result, mode = "module", module = module, chunkName = chunkName, lineOffset = offset }, nil
end

function runner.release(compiled: Compiled?)
	if compiled and compiled.module then
		compiled.module:Destroy()
		compiled.module = nil
	end
end

export type Capture = { output: { OutputEntry }, print: (...any) -> (), warn: (...any) -> (), finish: () -> { OutputEntry } }

-- print/warn replacements that record (capped) and forward to the real Studio output.
function runner.newCapture(): Capture
	local output: { OutputEntry } = {}
	local bytes = 0
	local dropped = 0
	local function make(level: string, forward: (...any) -> ())
		return function(...)
			local msg = util.formatArgs(...)
			if #output < protocol.OUTPUT_MAX_ENTRIES and bytes < protocol.OUTPUT_MAX_BYTES then
				local entry = util.truncate(util.utf8Safe(msg), 4096)
				bytes += #entry
				table.insert(output, { level = level, msg = entry, t = os.clock() })
			else
				dropped += 1
			end
			forward(...)
		end
	end
	return {
		output = output,
		print = make("print", print),
		warn = make("warn", warn),
		finish = function()
			if dropped > 0 then
				table.insert(output, { level = "info", msg = ("…[+%d more]"):format(dropped), t = os.clock() })
				dropped = 0
			end
			return output
		end,
	}
end

export type ExecResult = {
	ok: boolean,
	value: any,
	error: { [string]: any }?,
	duration_ms: number,
}

-- Runs a compiled program with the given S / ARGS and capture; never throws.
function runner.execute(compiled: Compiled, S: any, args: any, capture: Capture): ExecResult
	local fn = compiled.fn
	if compiled.mode == "loadstring" then
		local env = setmetatable({ S = S, ARGS = args, print = capture.print, warn = capture.warn }, { __index = baseEnv })
		setfenv(fn, env :: any)
	end
	local t0 = os.clock()
	local ok, result = xpcall(function()
		if compiled.mode == "loadstring" then
			return fn()
		end
		return fn(S, args, capture.print, capture.warn)
	end, function(err)
		return { err = err, stack = debug.traceback("", 2) }
	end)
	local duration = (os.clock() - t0) * 1000
	if ok then
		return { ok = true, value = result, duration_ms = util.round(duration) }
	end
	local raw = result.err
	local e: { [string]: any }
	if type(raw) == "table" and type(raw.code) == "string" then
		e = { code = raw.code, message = tostring(raw.message) }
	else
		e = { code = "luau_error", message = remapLines(tostring(raw), compiled.chunkName, compiled.lineOffset) }
	end
	e.stack = remapLines(result.stack, compiled.chunkName, compiled.lineOffset)
	return { ok = false, error = e, duration_ms = util.round(duration) }
end

-- Lets the deferred signal handlers queued so far (DescendantAdded / DescendantRemoving of the
-- program's changes) run before the caller continues, without paying a whole frame when it can be
-- avoided. Deferred handlers and task.defer share the same FIFO resumption point, so a sentinel
-- DescendantAdded queued after the program's events and a task.defer queued after that prove, once
-- the sentinel has fired, that everything queued earlier has fired too. When the sentinel has not
-- fired by then (another scheduling model, or Immediate behaviour was misdetected) one Heartbeat is
-- waited as before. Returns "immediate" | "deferred" | "frame" (the strategy that ended up being used).
function runner.flushDeferred(): string
	local sentinel = Instance.new("Folder")
	local fired = false
	local conn = sentinel.DescendantAdded:Connect(function()
		fired = true
	end)
	local probe = Instance.new("Folder")
	probe.Parent = sentinel
	local mode = "immediate"
	if not fired then
		local thread = coroutine.running()
		task.defer(function()
			pcall(task.spawn, thread)
		end)
		coroutine.yield()
		if fired then
			mode = "deferred"
		else
			task.wait()
			mode = "frame"
		end
	end
	conn:Disconnect()
	sentinel:Destroy()
	return mode
end

export type RunSpec = {
	code: string,
	args: any,
	S: any,
	ctl: Control?,
	journal: any?,
	ephemeral: boolean,
	detailed: boolean?,
	chunkName: string?,
	-- Geometry rules (protocol §4.1 `geometry`): "warn" reports overlapping / nested parts the
	-- program added in the body, "reject" fails the run with `geometry_violation` (the caller rolls
	-- back), "off" / nil skips the check. Needs `journal`.
	geometryPolicy: string?,
}

-- Overlap / nesting report for the BaseParts the journal saw added since `cursor` plus the ones the
-- program moved, resized or re-parented through S (`S.touched`; Models expand to their parts) — at
-- most MAX_PARTS in all, `sampled` when the run touched more than that or than the ring holds.
-- `budget` is work seconds (default RUN_BUDGET_S). nil when nothing was found.
function runner.geometryCheck(journal: any, cursor: number, S: any?, budget: number?): geometry.Report?
	local parts, partial = journal:addedInstances(cursor, geometry.MAX_PARTS)
	local touched = if type(S) == "table" and type(S.touched) == "table" then S.touched else nil
	if touched ~= nil and next(touched) ~= nil then
		local have: { [Instance]: boolean } = {}
		for _, p in ipairs(parts) do
			have[p] = true
		end
		local list: { Instance } = {}
		for inst in pairs(touched) do
			if typeof(inst) == "Instance" then
				table.insert(list, inst)
			end
		end
		for _, p in ipairs(geometry.expand(list, geometry.MAX_PARTS)) do
			if not have[p] and p:IsDescendantOf(game) then
				if #parts >= geometry.MAX_PARTS then
					partial = true
					break
				end
				have[p] = true
				table.insert(parts, p)
			end
		end
	end
	if #parts == 0 then
		return nil
	end
	local report = geometry.report(parts, { budget = budget or geometry.RUN_BUDGET_S, partial = partial })
	if geometry.isEmpty(report) then
		return nil
	end
	return report
end

-- Full `run` pipeline minus undo handling: returns (body, nil) or (nil, protocolError).
function runner.run(spec: RunSpec): ({ [string]: any }?, { [string]: any }?)
	local compiled, cerr = runner.compile(spec.code, spec.chunkName or "StudioLiveProgram", { ctl = spec.ctl })
	if compiled == nil then
		return nil, cerr
	end
	local capture = runner.newCapture()
	local cursor = if spec.journal then spec.journal:mark() else nil
	local released = false
	local function cleanup()
		if released then
			return
		end
		released = true
		if spec.journal then
			spec.journal:release()
		end
		runner.release(compiled)
	end
	if spec.ctl then
		-- A timeout / hard cancel kills the handler thread; the mark must still be released.
		spec.ctl.onAbort(cleanup)
	end
	if type(spec.S) == "table" then
		-- Only what this program moves counts for its geometry check (one S may serve several programs).
		spec.S.touched = setmetatable({}, { __mode = "k" })
		spec.S.touchedCount = 0
	end
	local result = runner.execute(compiled, spec.S, spec.args, capture)
	local flush: string? = nil
	if spec.journal and result.ok then
		-- DescendantAdded / DescendantRemoving are deferred: instances created in the program's
		-- last resumption reach the journal only at the next invocation point. duration_ms is
		-- already final; the flush usually costs no frame (see flushDeferred).
		flush = runner.flushDeferred()
	end
	local changes = if spec.journal then spec.journal:collect(cursor) else nil
	-- Geometry rules run on the flushed journal, while the mark is still held (the ring entries are
	-- the run's own), and only for a program that succeeded — an error rolls everything back anyway.
	local policy = spec.geometryPolicy
	local report: geometry.Report? = nil
	if result.ok and spec.journal and cursor ~= nil and (policy == "warn" or policy == "reject") then
		-- The check must not run the request into its deadline (that would roll a good program back
		-- as `timeout`): at most half of what is left, never less than 50 ms of work.
		local budget = geometry.RUN_BUDGET_S
		if spec.ctl then
			local okR, left = pcall(spec.ctl.remaining)
			if okR and type(left) == "number" and left < math.huge then
				budget = math.min(budget, math.max(0.05, left / 2))
			end
		end
		local okG, r = pcall(runner.geometryCheck, spec.journal, cursor, spec.S, budget)
		if okG then
			report = r
		else
			warn("[StudioLive] geometry check failed: " .. tostring(r))
		end
	end
	cleanup()
	local output = capture.finish()
	if not result.ok then
		local e = result.error :: { [string]: any }
		e.output = output
		return nil, e
	end
	if report ~= nil and policy == "reject" then
		local lines = geometry.warnings(report)
		return nil, util.perr("geometry_violation", ("geometry_policy 'reject': %s"):format(table.concat(lines, "; ")), {
			geometry = geometry.trim(report),
			warnings = lines,
			output = output,
			changes = changes,
		})
	end
	local body: { [string]: any } = {
		value = serialize.value(result.value, { detailed = spec.detailed }),
		output = output,
		duration_ms = result.duration_ms,
		changes = changes or { added = 0, removed = 0, paths = {} },
		ephemeral = spec.ephemeral,
	}
	if spec.detailed and flush then
		body.flush = flush
	end
	local warnings: { string } = {}
	-- Properties S.set / S.new could not write because the plugin VM lacks the capability (F8):
	-- reported instead of thrown, so one engine-gated property never rolls a whole build back. The
	-- same message also covers a misspelt property name, so the list is mirrored into `warnings`.
	local unwritable = if type(spec.S) == "table" then spec.S.unwritable else nil
	if type(unwritable) == "table" and #unwritable > 0 then
		body.unwritable = unwritable
		table.insert(warnings, runner.unwritableWarning(unwritable))
	end
	if report ~= nil then
		body.geometry = geometry.trim(report)
		for _, line in ipairs(geometry.warnings(report)) do
			table.insert(warnings, line)
		end
	end
	if #warnings > 0 then
		body.warnings = warnings
	end
	return body, nil
end

-- One line naming the first few unwritable properties (path.prop), for the run body's `warnings`.
function runner.unwritableWarning(list: { { [string]: any } }): string
	local names = {}
	for i, entry in ipairs(list) do
		if i > 5 then
			table.insert(names, ("… +%d more"):format(#list - 5))
			break
		end
		table.insert(names, ("%s.%s"):format(tostring(entry.path), tostring(entry.prop)))
	end
	return ("%d propert%s could not be written and %s skipped (engine-gated or misspelt; see unwritable): %s"):format(
		#list,
		if #list == 1 then "y" else "ies",
		if #list == 1 then "was" else "were",
		table.concat(names, ", ")
	)
end

return runner
