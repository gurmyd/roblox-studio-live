--[[
	`run` on the edit DM (§4.1): one ChangeHistoryService recording per program.
	Commit on success, Cancel (= rollback) on error / cancel / timeout / dry_run.
	A dry run that could not open a recording is refused (there would be no rollback).
]]

local ChangeHistoryService = game:GetService("ChangeHistoryService")

local geometry = require(script.Parent.Parent.shared.geometry)
local runner = require(script.Parent.Parent.shared.runner)
local types = require(script.Parent.Parent.shared.types)
local util = require(script.Parent.Parent.shared.util)

type Control = types.Control
type Request = types.Request

local Run = {}

export type Deps = { journal: any, makeS: (ctl: Control) -> any }

-- Instance:Destroy() locks Parent, so neither Cancel (dry_run, an error) nor Undo can bring the
-- instance back; the program text is scanned so the agent learns it before relying on rollback (F2).
local DESTROY_WARNING = "program calls :Destroy( — Instance:Destroy() locks Parent, so an error, dry_run or Undo cannot restore those instances; use S.destroy(inst) (Parent = nil, restorable) in the edit DM"

function Run.warnings(code: string): { string }?
	if string.find(code, ":Destroy(", 1, true) then
		return { DESTROY_WARNING }
	end
	return nil
end

function Run.handler(deps: Deps): (req: Request, ctl: Control) -> { [string]: any }
	return function(req: Request, ctl: Control)
		local body = req.body
		if type(body.code) ~= "string" then
			error(util.perr("bad_request", "run: 'code' must be a string"), 0)
		end
		-- Geometry rules (§4.1): the edit DM checks every run unless told "off"; a "reject" run is
		-- rolled back like an error (runner.run answers `geometry_violation`, handled below).
		local geometryPolicy, policyErr = geometry.policy(body.geometry_policy, "warn")
		if policyErr then
			error(util.perr("bad_request", "run: " .. policyErr), 0)
		end
		local label = if type(body.undo_label) == "string" and body.undo_label ~= "" then body.undo_label else "Studio Live run"
		local okRec, rec = pcall(ChangeHistoryService.TryBeginRecording, ChangeHistoryService, "StudioLive", label)
		local recording: string? = if okRec and type(rec) == "string" then rec else nil
		if body.dry_run == true and recording == nil then
			error(util.perr("busy", "dry_run needs a ChangeHistory recording to roll back, and none could be opened (a playtest is running or another recording is open)"), 0)
		end
		local finished = false
		local function finish(op: Enum.FinishRecordingOperation)
			if recording and not finished then
				finished = true
				pcall(ChangeHistoryService.FinishRecording, ChangeHistoryService, recording, op)
			end
		end
		-- Timeout / hard cancel: roll back before the handler thread is killed.
		ctl.onAbort(function()
			finish(Enum.FinishRecordingOperation.Cancel)
		end)

		local S = deps.makeS(ctl)
		local result, err = runner.run({
			code = body.code,
			args = body.args,
			S = S,
			ctl = ctl,
			journal = deps.journal,
			ephemeral = false,
			detailed = body.response_format == "detailed" or body.format == "detailed",
			geometryPolicy = geometryPolicy,
		})

		local undo: string
		if recording == nil then
			undo = "unavailable"
		elseif err ~= nil or body.dry_run == true then
			finish(Enum.FinishRecordingOperation.Cancel)
			undo = "cancelled"
		else
			finish(Enum.FinishRecordingOperation.Commit)
			undo = "committed"
		end
		-- Instances S.destroy detached stay referenced until here so Cancel could re-parent them;
		-- after Commit the undo stack holds its own reference.
		local detached = if type(S.detached) == "table" then #S.detached else 0
		S.detached = nil
		if err then
			if type(err) == "table" and err.code == "geometry_violation" then
				-- The program itself succeeded; say what happened to its effects (protocol.err keeps `undo`).
				err.undo = undo
				if undo ~= "cancelled" then
					-- No recording could be opened (a playtest is running or another recording is open): nothing
					-- rolled back, and the error must not read as if it had.
					err.message = tostring(err.message) .. " (no ChangeHistory recording could be opened, so the parts were NOT removed — fix or delete them; undo: unavailable)"
				end
			end
			error(err, 0)
		end
		local out = result :: { [string]: any }
		out.undo = undo
		out.ephemeral = false
		if detached > 0 then
			out.detached = detached
		end
		-- The :Destroy( lint first, then whatever the runner added (unwritable properties).
		local warnings = Run.warnings(body.code) or {}
		if type(out.warnings) == "table" then
			for _, w in ipairs(out.warnings) do
				table.insert(warnings, w)
			end
		end
		out.warnings = if #warnings > 0 then warnings else nil
		return out
	end
end

return Run
