--[[
	Request dispatcher shared by hub and agent.

	- one task.spawn per `req`; the handler returns a body table or throws a
	  { code, message } table (see util.perr) / any error (→ code "internal")
	- deadline: `timeout` error and hard cancel of the handler thread (abort hooks
	  run first so a handler can roll back a ChangeHistory recording)
	- cancel: cooperative flag; hard cancel after a 1 s grace
	- writes: ops flagged as writes are exclusive per DM; a write that arrives while
	  another runs waits in a FIFO queue (QUEUE_MAX deep, then `busy`). A queued request
	  keeps its absolute deadline (`timeout` if it expires before starting), can be
	  cancelled while waiting (`cancelled` at once, nothing to unwind) and gets one
	  `progress` frame "queued behind N" once it has waited QUEUE_NOTICE_S. Reads never queue.
	- a request that ran (from launch, queue wait excluded) longer than JOB_EVENT_AFTER_S ends
	  with a `job` event (§2.5), so a client watching the push stream learns that a job handle finished
	- draining: queued writes are launched back to back within one frame until the launches of that
	  frame have used SLICE_BUDGET_S of wall time (the same 8 ms slice S.yield() honours); the rest of
	  the queue continues from the next Heartbeat, so a burst of trivial writes never starves rendering
	  and never costs one frame per write either. Every launch (queued or direct) starts or joins the
	  frame's burst and hands its start to the handler as ctl.sliceStart, so a program's S.yield()
	  measures the slice from the burst start, not from its own launch: the frame yields once the burst
	  has used 8 ms plus, at worst, the time to the running program's next S.yield().
]]

local RunService = game:GetService("RunService")

local protocol = require(script.Parent.protocol)
local types = require(script.Parent.types)
local util = require(script.Parent.util)

type Control = types.Control
type Request = types.Request

local Dispatcher = {}
Dispatcher.__index = Dispatcher

local JOB_EVENT_AFTER_S = 5
local QUEUE_MAX = 500
local QUEUE_NOTICE_S = 0.25
-- Wall time the pump may spend launching queued writes within one frame before yielding to the next.
local SLICE_BUDGET_S = 0.008

export type Handler = (req: Request, ctl: Control) -> any
export type Emit = (ev: { [string]: any }) -> number

type Entry = {
	id: string,
	op: string,
	req: Request,
	handler: Handler,
	ctl: Control,
	done: boolean,
	queued: boolean,
	cancelRequested: boolean,
	abortHooks: { () -> () },
	thread: thread?,
	deadlineThread: thread?,
	noticeThread: thread?,
	lastProgress: number,
	arrivedAt: number,
	startedAt: number,
	deadline: number,
}

export type Dispatcher = typeof(setmetatable(
	{} :: {
		dm: string,
		send: (frame: { [string]: any }) -> (),
		emit: Emit?,
		handlers: { [string]: Handler },
		writes: { [string]: boolean },
		inflight: { [string]: any },
		queue: { any },
		activeWrite: string?,
		pumping: boolean,
		paused: boolean,
		warn: (string) -> (),
		-- Heartbeat counter and the launch burst of the current frame (see pump).
		frame: number,
		burstFrame: number,
		burstStart: number,
		frameScheduled: boolean,
		frameConn: RBXScriptConnection?,
		stopped: boolean,
	},
	Dispatcher
))

function Dispatcher.new(dm: string, send: (frame: { [string]: any }) -> (), emit: Emit?): Dispatcher
	local self = setmetatable({
		dm = dm,
		send = send,
		emit = emit,
		handlers = {},
		writes = {},
		inflight = {},
		queue = {},
		activeWrite = nil,
		pumping = false,
		paused = false,
		warn = util.rateLimitedWarn(5),
		frame = 0,
		burstFrame = -1,
		burstStart = 0,
		frameScheduled = false,
		frameConn = nil,
		stopped = false,
	}, Dispatcher)
	-- One Heartbeat connection per dispatcher tells the pump when a new frame began.
	local ok, conn = pcall(function()
		return RunService.Heartbeat:Connect(function()
			self.frame += 1
		end)
	end)
	if ok then
		self.frameConn = conn
	end
	return self
end

-- Releases the Heartbeat connection; queued work is left to failAll / cancelAll.
function Dispatcher.stop(self: Dispatcher)
	self.stopped = true
	if self.frameConn then
		pcall(self.frameConn.Disconnect, self.frameConn)
		self.frameConn = nil
	end
end

-- `isWrite` marks the op as exclusive (queued while another write runs).
function Dispatcher.register(self: Dispatcher, op: string, handler: Handler, isWrite: boolean?)
	self.handlers[op] = handler
	if isWrite then
		self.writes[op] = true
	end
end

-- Validates a raw `req` frame; returns a Request or nil + message.
function Dispatcher.parseRequest(frame: { [string]: any }): (Request?, string?)
	if type(frame.id) ~= "string" or frame.id == "" then
		return nil, "req.id must be a non-empty string"
	end
	if type(frame.op) ~= "string" then
		return nil, "req.op must be a string"
	end
	local body = frame.body
	if body == nil then
		body = {}
	elseif type(body) ~= "table" then
		return nil, "req.body must be an object"
	end
	return {
		id = frame.id,
		op = frame.op,
		dm = if type(frame.dm) == "string" then frame.dm else "edit",
		deadline_ms = util.num(frame.deadline_ms, protocol.DEFAULT_DEADLINE_MS, 1, 3600000),
		body = body,
	}, nil
end

function Dispatcher.handle(self: Dispatcher, frame: { [string]: any })
	local kind = frame.kind
	if kind == "req" then
		self:handleRequest(frame)
	elseif kind == "cancel" then
		if type(frame.id) == "string" then
			self:cancel(frame.id)
		end
	elseif kind == "cancel_all" then
		self:cancelAll()
	end
end

-- Number of write requests waiting (not counting the one running).
function Dispatcher.queued(self: Dispatcher): number
	return #self.queue
end

local function unqueue(self: Dispatcher, entry: Entry)
	if not entry.queued then
		return
	end
	entry.queued = false
	for i, e in ipairs(self.queue) do
		if e == entry then
			table.remove(self.queue, i)
			break
		end
	end
end

-- Continues the pump on the next Heartbeat (never yields the caller, which may be a signal handler).
function Dispatcher.scheduleFrame(self: Dispatcher)
	if self.frameScheduled or self.stopped then
		return
	end
	self.frameScheduled = true
	task.delay(0, function()
		self.frameScheduled = false
		-- A new frame began: start a fresh burst whatever the Heartbeat counter says (the delayed
		-- thread and the Heartbeat handler have no fixed order, and the counter may be unavailable).
		self.burstFrame = -1
		if not self.stopped then
			self:pump()
		end
	end)
end

-- Starts the next queued write(s) once no write is active. Iterative: a handler that
-- finishes without yielding re-enters here and returns at once (pumping flag), and the
-- outer loop moves on, so long queues of trivial writes never nest coroutines deeply.
-- Launches within one frame share SLICE_BUDGET_S; past it the queue waits for the next frame.
function Dispatcher.pump(self: Dispatcher)
	if self.pumping or self.paused then
		return
	end
	self.pumping = true
	while self.activeWrite == nil and #self.queue > 0 do
		if self.burstFrame == self.frame and os.clock() - self.burstStart > SLICE_BUDGET_S then
			-- This frame has had its share of writes: the rest drains from the next Heartbeat.
			self:scheduleFrame()
			break
		end
		local nxt = table.remove(self.queue, 1) :: Entry
		nxt.queued = false
		if not nxt.done then
			self:launch(nxt)
		end
	end
	self.pumping = false
end

function Dispatcher.finish(self: Dispatcher, entry: Entry, frame: { [string]: any })
	if entry.done then
		return
	end
	entry.done = true
	self.inflight[entry.id] = nil
	unqueue(self, entry)
	local wasActive = self.activeWrite == entry.id
	if wasActive then
		self.activeWrite = nil
	end
	if entry.deadlineThread and entry.deadlineThread ~= coroutine.running() then
		pcall(task.cancel, entry.deadlineThread)
	end
	if entry.noticeThread and entry.noticeThread ~= coroutine.running() then
		pcall(task.cancel, entry.noticeThread)
	end
	self.send(frame)
	-- Measured from launch, not arrival: a 1 ms write that merely waited in the queue is not a job
	-- worth an event (a request that never launched keeps startedAt = arrivedAt, so a long-queued
	-- timeout / cancel still reports).
	if self.emit and os.clock() - entry.startedAt >= JOB_EVENT_AFTER_S then
		local ev: { [string]: any } = { type = "job", id = entry.id, op = entry.op }
		if frame.ok == true then
			ev.status = "done"
		else
			local err = if type(frame.error) == "table" then frame.error else {}
			ev.status = if err.code == "cancelled" then "cancelled" else "error"
			ev.note = if type(err.message) == "string" then util.truncate(err.message, 256) else nil
		end
		pcall(self.emit, ev)
	end
	if wasActive then
		self:pump()
	end
end

-- Runs abort hooks (rollback etc.) then kills the handler thread. A queued entry has
-- neither, so it simply leaves the queue with the given error.
function Dispatcher.abort(self: Dispatcher, entry: Entry, code: string, message: string)
	if entry.done then
		return
	end
	for _, hook in ipairs(entry.abortHooks) do
		pcall(hook)
	end
	local thread = entry.thread
	if thread and thread ~= coroutine.running() and coroutine.status(thread) == "suspended" then
		pcall(task.cancel, thread)
	end
	self:finish(entry, protocol.err(entry.id, self.dm, { code = code, message = message }))
end

-- Runs the handler now (the entry is admitted and, for writes, owns the write slot).
function Dispatcher.launch(self: Dispatcher, entry: Entry)
	entry.startedAt = os.clock()
	-- The "queued behind N" notice must not eat the handler's first progress call (4/s limit).
	entry.lastProgress = -math.huge
	-- First launch of this frame starts its burst; later ones join it and share the slice (S.yield).
	if self.burstFrame ~= self.frame then
		self.burstFrame = self.frame
		self.burstStart = entry.startedAt
	end
	entry.ctl.sliceStart = self.burstStart
	if self.writes[entry.op] then
		self.activeWrite = entry.id
	end
	local req = entry.req
	entry.thread = task.spawn(function()
		local ok, result = xpcall(entry.handler, function(err)
			local e = util.toProtocolError(err)
			if e.code == "internal" and e.stack == nil then
				e.stack = debug.traceback(nil, 2)
			end
			return e
		end, req, entry.ctl)
		if entry.done then
			return
		end
		if ok then
			self:finish(entry, protocol.res(req.id, self.dm, result))
		else
			if entry.cancelRequested and result.code ~= "cancelled" then
				result = { code = "cancelled", message = "cancelled by request", output = result.output }
			end
			self:finish(entry, protocol.err(req.id, self.dm, result))
		end
	end)
end

function Dispatcher.handleRequest(self: Dispatcher, frame: { [string]: any })
	local req, why = Dispatcher.parseRequest(frame)
	if req == nil then
		local id = if type(frame.id) == "string" then frame.id else "?"
		self.send(protocol.err(id, self.dm, { code = "bad_request", message = why or "bad request" }))
		return
	end
	local handler = self.handlers[req.op]
	if handler == nil then
		self.send(protocol.err(req.id, self.dm, { code = "unsupported", message = ("unknown op '%s'"):format(req.op) }))
		return
	end
	if self.inflight[req.id] ~= nil then
		self.send(
			protocol.err(req.id, self.dm, { code = "bad_request", message = ("duplicate request id '%s'"):format(req.id) })
		)
		return
	end
	local isWrite = self.writes[req.op] == true
	-- A write waits whenever one runs or others already wait (FIFO), so nothing overtakes the queue.
	local mustQueue = isWrite and (self.activeWrite ~= nil or #self.queue > 0)
	if mustQueue and #self.queue >= QUEUE_MAX then
		self.send(protocol.err(req.id, self.dm, {
			code = "busy",
			message = ("write queue is full (%d waiting behind %s)"):format(#self.queue, tostring(self.activeWrite)),
		}))
		return
	end

	local now = os.clock()
	local deadline = now + req.deadline_ms / 1000
	local entry: Entry
	local ctl: Control = {
		id = req.id,
		deadline = deadline,
		cancelled = function()
			return entry.cancelRequested
		end,
		checkCancel = function()
			if entry.cancelRequested then
				error(util.perr("cancelled", "cancelled by request"), 0)
			end
		end,
		progress = function(note: string?, pct: number?)
			local now2 = os.clock()
			if entry.done or now2 - entry.lastProgress < protocol.PROGRESS_MIN_INTERVAL then
				return
			end
			entry.lastProgress = now2
			self.send(protocol.progress(req.id, note, pct))
		end,
		onAbort = function(fn: () -> ())
			table.insert(entry.abortHooks, fn)
		end,
		remaining = function()
			return math.max(0, entry.deadline - os.clock())
		end,
		sliceStart = nil,
	}
	entry = {
		id = req.id,
		op = req.op,
		req = req,
		handler = handler,
		ctl = ctl,
		done = false,
		queued = false,
		cancelRequested = false,
		abortHooks = {},
		thread = nil,
		deadlineThread = nil,
		noticeThread = nil,
		lastProgress = -math.huge,
		arrivedAt = now,
		startedAt = now,
		deadline = deadline,
	}
	self.inflight[req.id] = entry

	-- The deadline is absolute: it counts from arrival, queue wait included.
	entry.deadlineThread = task.delay(req.deadline_ms / 1000, function()
		self:abort(entry, "timeout", ("deadline of %d ms exceeded"):format(req.deadline_ms))
	end)

	if mustQueue then
		entry.queued = true
		table.insert(self.queue, entry)
		entry.noticeThread = task.delay(QUEUE_NOTICE_S, function()
			if entry.done or not entry.queued then
				return
			end
			local ahead = if self.activeWrite ~= nil then 1 else 0
			for i, e in ipairs(self.queue) do
				if e == entry then
					ahead += i - 1
					break
				end
			end
			-- Sent directly: it is not one of the handler's progress notes and must not rate-limit them.
			self.send(protocol.progress(req.id, ("queued behind %d"):format(ahead)))
		end)
		return
	end
	self:launch(entry)
end

function Dispatcher.cancel(self: Dispatcher, id: string)
	local entry = self.inflight[id] :: Entry?
	if entry == nil or entry.done then
		return
	end
	entry.cancelRequested = true
	if entry.queued then
		-- Nothing has run yet: leave the queue at once.
		self:abort(entry, "cancelled", "cancelled by request")
		return
	end
	-- Cooperative first (S.yield / S.wait observe the flag); hard cancel after a grace period.
	task.delay(1, function()
		self:abort(entry, "cancelled", "cancelled by request")
	end)
end

-- Runs `fn` with queue pumping suspended, so a bulk cancel/fail never starts a queued
-- write only to kill it a moment later; pumps once afterwards.
local function withPumpPaused(self: Dispatcher, fn: () -> ())
	local wasPaused = self.paused
	self.paused = true
	local ok, err = pcall(fn)
	self.paused = wasPaused
	if not wasPaused then
		self:pump()
	end
	if not ok then
		error(err, 0)
	end
end

function Dispatcher.cancelAll(self: Dispatcher)
	withPumpPaused(self, function()
		for id in pairs(self.inflight) do
			self:cancel(id)
		end
	end)
end

-- Fails every in-flight (running or queued) request (used on link loss / stop).
function Dispatcher.failAll(self: Dispatcher, code: string, message: string)
	withPumpPaused(self, function()
		for _, entry in pairs(self.inflight) do
			self:abort(entry, code, message)
		end
	end)
end

return Dispatcher
