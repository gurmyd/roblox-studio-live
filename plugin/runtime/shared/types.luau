--[[
	Shared type declarations for the Studio Live runtime.
	Purely compile-time; requiring this module returns an empty table.
]]

export type Frame = { [string]: any }

export type Link = {
	send: (text: string) -> boolean,
	onFrame: (fn: (text: string, decoded: Frame?) -> ()) -> () -> (),
	isOpen: () -> boolean,
	stats: () -> { [string]: any },
}

export type Bundle = {
	hash: string,
	entry: string,
	modules: { [string]: string },
}

-- Handed to runtime.start() by the bootstrap (protocol.md §1.1 / §1.2 and Notes).
export type Ctx = {
	plugin: Plugin,
	role: string, -- "edit" | "server" | "client"
	session: string?,
	link: Link,
	bundleHash: string,
	bootstrapVersion: string,
	lastSeq: number?,
	ackUpto: number?,
	bridgeId: string?,
	bundle: Bundle?,
	hubTargetId: string?,
	dm: string?,
}

export type Runtime = {
	stop: () -> (),
	relinked: (ackUpto: number?, bridgeId: string?) -> (),
	lastSeq: (() -> number)?,
}

export type Request = {
	id: string,
	op: string,
	dm: string,
	deadline_ms: number,
	body: { [string]: any },
}

-- Per-request control handle given to op handlers (see shared/dispatcher.luau).
export type Control = {
	id: string,
	deadline: number, -- os.clock() value
	cancelled: () -> boolean,
	checkCancel: () -> (),
	progress: (note: string?, pct: number?) -> (),
	onAbort: (fn: () -> ()) -> (),
	remaining: () -> number,
	-- os.clock() at which the dispatcher's launch burst of this frame began; S.yield() measures its
	-- 8 ms slice from here so several writes launched in one frame share the slice.
	sliceStart: number?,
}

export type ProtocolError = {
	code: string,
	message: string,
	stack: string?,
	output: { OutputEntry }?,
}

export type OutputEntry = { level: string, msg: string, t: number }

export type Emit = (ev: Frame) -> number

-- Environment shared by every op implementation in a DM.
export type Env = {
	role: string,
	dm: string,
	session: string,
	emit: Emit,
	journal: any,
	logs: any,
	fps: () -> number,
	hasLoadstring: boolean,
	-- Edit DM: the live editor buffer of a script (ScriptEditorService:GetEditorSource), nil elsewhere.
	scriptSource: ((script: LuaSourceContainer) -> string?)?,
}

return {}
