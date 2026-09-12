--[[
	Heartbeat-based FPS meter (1 s windows). Used for `hb.fps` and `observe stats`.
]]

local RunService = game:GetService("RunService")

local Fps = {}
Fps.__index = Fps

export type Fps = typeof(setmetatable(
	{} :: { frames: number, windowStart: number, value_: number, conn: RBXScriptConnection? },
	Fps
))

function Fps.new(): Fps
	local self = setmetatable({ frames = 0, windowStart = os.clock(), value_ = 0, conn = nil }, Fps)
	self.conn = RunService.Heartbeat:Connect(function()
		self.frames += 1
		local elapsed = os.clock() - self.windowStart
		if elapsed >= 1 then
			self.value_ = self.frames / elapsed
			self.frames = 0
			self.windowStart = os.clock()
		end
	end)
	return self
end

function Fps.value(self: Fps): number
	return self.value_
end

function Fps.stop(self: Fps)
	if self.conn then
		self.conn:Disconnect()
		self.conn = nil
	end
end

return Fps
