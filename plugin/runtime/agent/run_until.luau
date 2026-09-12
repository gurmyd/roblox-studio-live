--[[
	`playtest run_until` (§4.3): compile a predicate once, evaluate it every Heartbeat
	(or every interval_ms) until truthy, timeout, or 3 consecutive predicate errors.
]]

local RunService = game:GetService("RunService")

local runner = require(script.Parent.Parent.shared.runner)
local serialize = require(script.Parent.Parent.shared.serialize)
local types = require(script.Parent.Parent.shared.types)
local util = require(script.Parent.Parent.shared.util)

type Control = types.Control

local runUntil = {}

local MAX_TIMEOUT_MS = 120000
local MAX_CONSECUTIVE_ERRORS = 3

-- An expression ("door.Open") is wrapped in `return (…)`, which puts one extra line above the
-- agent's text; a chunk is compiled as-is. Both report line numbers relative to the predicate.
local function compilePredicate(predicate: string, ctl: Control): runner.Compiled
	local expr, exprErr = runner.compile("return (\n" .. predicate .. "\n)", "StudioLivePredicate", { lineOffset = 1, ctl = ctl })
	if expr then
		return expr
	end
	local chunk, chunkErr = runner.compile(predicate, "StudioLivePredicate", { ctl = ctl })
	if chunk then
		return chunk
	end
	local e = chunkErr or exprErr or util.perr("syntax_error", "cannot compile predicate")
	error(e, 0)
end

function runUntil.run(body: { [string]: any }, ctl: Control, S: any): { [string]: any }
	if type(body.predicate) ~= "string" or body.predicate == "" then
		error(util.perr("bad_request", "run_until: 'predicate' must be a non-empty string"), 0)
	end
	local timeout = util.num(body.timeout_ms, 30000, 1, MAX_TIMEOUT_MS) / 1000
	local interval = util.num(body.interval_ms, 0, 0, 60000) / 1000
	local compiled = compilePredicate(body.predicate, ctl)
	ctl.onAbort(function()
		runner.release(compiled)
	end)
	local capture = runner.newCapture()
	local t0 = os.clock()
	local deadline = t0 + timeout
	local checks = 0
	local errors = 0
	local lastError: { [string]: any }? = nil
	local function finish(result: any, value: any): { [string]: any }
		runner.release(compiled)
		return {
			result = result,
			value = serialize.value(value),
			elapsed_ms = util.round((os.clock() - t0) * 1000),
			checks = checks,
		}
	end
	while true do
		ctl.checkCancel()
		local r = runner.execute(compiled, S, body.args, capture)
		checks += 1
		if r.ok then
			errors = 0
			if r.value then
				return finish(true, r.value)
			end
		else
			errors += 1
			lastError = r.error
			if errors >= MAX_CONSECUTIVE_ERRORS then
				runner.release(compiled)
				local e = lastError :: { [string]: any }
				error(util.perr("luau_error", ("predicate errored %d times: %s"):format(errors, tostring(e.message)), {
					stack = e.stack,
					output = capture.finish(),
				}), 0)
			end
		end
		if os.clock() >= deadline then
			return finish("timeout", nil)
		end
		if interval > 0 then
			task.wait(interval)
		else
			RunService.Heartbeat:Wait()
		end
	end
end

return runUntil
