--[[
	Fixed-capacity ring buffer. Items are appended in order; the oldest is dropped
	when full and counted in `dropped`. Items are expected (not required) to carry a
	monotonic `seq` field so callers can page with `since(seq)`.
]]

local Ring = {}
Ring.__index = Ring

export type Ring = typeof(setmetatable(
	{} :: { cap: number, items: { any }, first: number, count: number, dropped: number },
	Ring
))

function Ring.new(capacity: number): Ring
	return setmetatable({ cap = math.max(1, capacity), items = {}, first = 1, count = 0, dropped = 0 }, Ring)
end

function Ring.push(self: Ring, item: any)
	if self.count < self.cap then
		local idx = (self.first + self.count - 1) % self.cap + 1
		self.items[idx] = item
		self.count += 1
	else
		self.items[self.first] = item
		self.first = self.first % self.cap + 1
		self.dropped += 1
	end
end

function Ring.size(self: Ring): number
	return self.count
end

function Ring.at(self: Ring, i: number): any
	if i < 1 or i > self.count then
		return nil
	end
	return self.items[(self.first + i - 2) % self.cap + 1]
end

-- Returns up to `limit` items in insertion order; `pred` filters.
function Ring.collect(self: Ring, pred: ((any) -> boolean)?, limit: number?): { any }
	local out = {}
	local max = limit or self.count
	for i = 1, self.count do
		local item = self:at(i)
		if pred == nil or pred(item) then
			table.insert(out, item)
			if #out >= max then
				break
			end
		end
	end
	return out
end

-- Items with seq > since, oldest first.
function Ring.since(self: Ring, since: number, limit: number?): { any }
	return self:collect(function(item)
		return type(item.seq) == "number" and item.seq > since
	end, limit)
end

-- Last `n` items in insertion order.
function Ring.tail(self: Ring, n: number, pred: ((any) -> boolean)?): { any }
	local out = {}
	for i = self.count, 1, -1 do
		local item = self:at(i)
		if pred == nil or pred(item) then
			table.insert(out, 1, item)
			if #out >= n then
				break
			end
		end
	end
	return out
end

-- Drops items from the front while `pred` holds; returns the number dropped.
function Ring.dropWhile(self: Ring, pred: (any) -> boolean): number
	local n = 0
	while self.count > 0 do
		local item = self.items[self.first]
		if not pred(item) then
			break
		end
		self.items[self.first] = nil
		self.first = self.first % self.cap + 1
		self.count -= 1
		n += 1
	end
	return n
end

-- Returns and resets the overflow counter.
function Ring.takeDropped(self: Ring): number
	local d = self.dropped
	self.dropped = 0
	return d
end

return Ring
