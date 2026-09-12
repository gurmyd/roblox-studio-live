/**
 * The Luau programs the sync ships through the `run` tool. Everything variable travels in
 * ARGS (JSON), so the programs are fixed text and never need Luau string escaping.
 * ARGS.op names the program so a fake bridge (tests) can tell them apart.
 */
import type { ParentSpec, ScriptClass } from './layout.js';

/** Largest slice of a source returned in one JSON string (§7 caps strings at 8 KB). */
export const FETCH_PART_BYTES = 4000;
/** Default raw-source budget per fetch call; JSON escaping can double it, the tool result budget is 60,000 chars. */
export const FETCH_BUDGET_BYTES = 24_000;
/** Listing page size (≤ 200 per the sync contract). */
export const LIST_PAGE = 200;

/** Same function as state.ts `hashSource`: byte-wise (h * 31 + b) mod 2^32, reported as "<len>-<h>". */
const HASH_LUAU = `local function hash(s)
	local h = 0
	local n = #s
	local i = 1
	while i + 7 <= n do
		local a, b, c, d, e, f, g, k = string.byte(s, i, i + 7)
		h = (h * 31 + a) % 4294967296
		h = (h * 31 + b) % 4294967296
		h = (h * 31 + c) % 4294967296
		h = (h * 31 + d) % 4294967296
		h = (h * 31 + e) % 4294967296
		h = (h * 31 + f) % 4294967296
		h = (h * 31 + g) % 4294967296
		h = (h * 31 + k) % 4294967296
		i += 8
	end
	while i <= n do
		h = (h * 31 + string.byte(s, i)) % 4294967296
		i += 1
	end
	return string.format("%d-%d", n, h)
end
local function norm(s)
	return (string.gsub(s, "\\r\\n", "\\n"))
end
-- Reads the editor buffer when one is open (S.script.get), tolerating scripts whose source is not readable.
local function readSource(inst)
	local ok, src = pcall(S.script.get, inst)
	if ok and type(src) == "string" then
		return src
	end
	return nil
end`;

/** Studio-internal trees never hold user scripts; the same list the hub's `find` skips. */
const SKIP_LUAU = `local SKIP = { Stats = true, CoreGui = true, CorePackages = true, PluginGuiService = true, PluginDebugService = true, RobloxPluginGuiService = true, StudioService = true }`;

export interface PushItem {
  rel: string;
  service: string;
  parents: ParentSpec[];
  name: string;
  class: ScriptClass;
  /** Normalised (LF) source. */
  src: string;
  /** Hash recorded at the last sync, or null when this file was never synced. */
  prev: string | null;
}

export type PushOutcome = 'created' | 'updated' | 'unchanged' | 'replaced' | 'skipped';

/** Shape of the push program's return value. */
export interface PushResult {
  created: number;
  updated: number;
  unchanged: number;
  replaced: number;
  parents: number;
  outcomes: PushOutcome[];
  skipped: Array<{ i: number; why: string }>;
  /** 1-based item indexes whose Studio copy changed since the last sync (and was overwritten). */
  conflicts: number[];
  /** 1-based item indexes with no sync record whose non-empty Studio copy was overwritten. */
  overwrote: number[];
}

/**
 * One `run` per batch: creates missing parents (Folder, or the init script class), creates
 * scripts of the right class, replaces a script whose class changed on disk (children kept),
 * and writes sources through S.script.set (ScriptEditorService path on the edit DM).
 */
export const PUSH_PROGRAM = `-- studio-live sync: push ARGS.items into the open place
${HASH_LUAU}
local R = { created = 0, updated = 0, unchanged = 0, replaced = 0, parents = 0, outcomes = {}, skipped = {}, conflicts = {}, overwrote = {} }
local DIRECT_SOURCE_MAX = 190000 -- direct Source writes are capped around 200k chars; larger goes through S.script.set
local function skip(i, why)
	R.outcomes[i] = "skipped"
	table.insert(R.skipped, { i = i, why = why })
end
local function ensureParent(parent, spec)
	local child = parent:FindFirstChild(spec.name)
	if child ~= nil then
		return child
	end
	local ok, made = pcall(Instance.new, spec.class)
	if not ok then
		return nil, ("cannot create %s '%s': %s"):format(tostring(spec.class), tostring(spec.name), tostring(made))
	end
	made.Name = spec.name
	made.Parent = parent
	R.parents += 1
	return made
end
for i, it in ipairs(ARGS.items) do
	local okSvc, parent = pcall(game.GetService, game, it.service)
	if not okSvc or typeof(parent) ~= "Instance" then
		skip(i, ("'%s' is not a service"):format(tostring(it.service)))
	else
		local failed = nil
		for _, spec in ipairs(it.parents) do
			local child, why = ensureParent(parent, spec)
			if child == nil then
				failed = why
				break
			end
			parent = child
		end
		if failed ~= nil then
			skip(i, failed)
		else
			local src = it.src
			local inst = parent:FindFirstChild(it.name)
			if inst ~= nil and not inst:IsA("LuaSourceContainer") then
				skip(i, ("%s is a %s, not a script"):format(S.path(inst), inst.ClassName))
			elseif inst == nil then
				if #src > DIRECT_SOURCE_MAX then
					local made = S.script.create(it.class, it.name, parent, "")
					S.script.set(made, src)
				else
					S.script.create(it.class, it.name, parent, src)
				end
				R.created += 1
				R.outcomes[i] = "created"
			elseif inst.ClassName ~= it.class then
				-- The class changed on disk (e.g. .luau → .server.luau); ClassName is read-only, so replace and keep children.
				local fresh = Instance.new(it.class)
				fresh.Name = it.name
				for _, c in ipairs(inst:GetChildren()) do
					c.Parent = fresh
				end
				fresh.Parent = parent
				inst:Destroy()
				S.script.set(fresh, src)
				R.replaced += 1
				R.outcomes[i] = "replaced"
			else
				local cur = readSource(inst)
				cur = if cur ~= nil then norm(cur) else ""
				if cur == src then
					R.unchanged += 1
					R.outcomes[i] = "unchanged"
				else
					if it.prev ~= nil then
						if hash(cur) ~= it.prev then
							table.insert(R.conflicts, i)
						end
					elseif cur ~= "" then
						table.insert(R.overwrote, i)
					end
					S.script.set(inst, src)
					R.updated += 1
					R.outcomes[i] = "updated"
				end
			end
		end
	end
	if i % 16 == 0 then
		S.yield()
	end
end
return R
`;

export interface ListItem {
  /** Name chain from the service down. */
  n: string[];
  c: ScriptClass;
  /** Hash of the normalised source (see hashSource). */
  h: string;
}

export interface ListResult {
  total: number;
  items: ListItem[];
}

/**
 * Cheap checksum listing of every script in the place: ARGS.offset / ARGS.limit page through
 * a deterministic walk (services in game:GetChildren() order, then GetDescendants order).
 */
export const LIST_PROGRAM = `-- studio-live sync: list scripts with checksums (page ARGS.offset, ARGS.limit)
${HASH_LUAU}
${SKIP_LUAU}
local offset = tonumber(ARGS.offset) or 0
local limit = math.max(1, math.min(${LIST_PAGE}, tonumber(ARGS.limit) or ${LIST_PAGE}))
local items = {}
local total = 0
for _, svc in ipairs(game:GetChildren()) do
	if not SKIP[svc.Name] and not SKIP[svc.ClassName] then
		local okDesc, desc = pcall(svc.GetDescendants, svc)
		if okDesc then
			for _, d in ipairs(desc) do
				if d:IsA("LuaSourceContainer") then
					total += 1
					if total > offset and #items < limit then
						local src = readSource(d)
						if src ~= nil then
							local names = {}
							local node = d
							while node ~= nil and node ~= game do
								table.insert(names, 1, node.Name)
								node = node.Parent
							end
							table.insert(items, { n = names, c = d.ClassName, h = hash(norm(src)) })
						end
					end
				end
			end
		end
	end
end
return { total = total, items = items }
`;

export interface FetchRequest {
  n: string[];
  /** 1-based byte offset to continue from (omit for the start). */
  from?: number;
}

export interface FetchItem {
  n: string[];
  missing?: boolean;
  c?: ScriptClass;
  h?: string;
  len?: number;
  from?: number;
  next?: number;
  eof?: boolean;
  parts?: string[];
}

export interface FetchResult {
  items: FetchItem[];
}

/**
 * Returns sources for ARGS.reqs in order, as UTF-8-safe slices of ≤ ARGS.part bytes, stopping
 * once ARGS.budget bytes have been collected; a request cut short reports `next` and `eof=false`.
 */
export const FETCH_PROGRAM = `-- studio-live sync: fetch sources for ARGS.reqs (budget ARGS.budget bytes, parts of ARGS.part bytes)
${HASH_LUAU}
local budget = math.max(1000, tonumber(ARGS.budget) or ${FETCH_BUDGET_BYTES})
local part = math.max(256, math.min(${FETCH_PART_BYTES}, tonumber(ARGS.part) or ${FETCH_PART_BYTES}))
local function find(names)
	local node = game
	for _, name in ipairs(names) do
		local nxt = node:FindFirstChild(name)
		if nxt == nil and node == game then
			local ok, svc = pcall(game.GetService, game, name)
			if ok and typeof(svc) == "Instance" then
				nxt = svc
			end
		end
		if nxt == nil then
			return nil
		end
		node = nxt
	end
	return node
end
local out = {}
local used = 0
for _, r in ipairs(ARGS.reqs) do
	if used >= budget then
		break
	end
	local inst = find(r.n)
	local src = if inst ~= nil and inst:IsA("LuaSourceContainer") then readSource(inst) else nil
	if src == nil then
		table.insert(out, { n = r.n, missing = true })
	else
		src = norm(src)
		local len = #src
		local from = math.max(1, tonumber(r.from) or 1)
		local parts = {}
		local pos = from
		while pos <= len and used < budget do
			local e = math.min(len, pos + part - 1)
			-- Never split a UTF-8 sequence: back up while the next byte is a continuation byte.
			local limit = e
			while limit < len and limit > pos do
				local b = string.byte(src, limit + 1)
				if b >= 0x80 and b < 0xC0 then
					limit -= 1
				else
					break
				end
			end
			if limit >= pos then
				e = limit
			end
			table.insert(parts, string.sub(src, pos, e))
			used += e - pos + 1
			pos = e + 1
		end
		table.insert(out, { n = r.n, c = inst.ClassName, h = hash(src), len = len, from = from, next = pos, eof = pos > len, parts = parts })
	end
end
return { items = out }
`;

/** Builds the `run` tool arguments for one push batch. */
export function pushRunArgs(items: readonly PushItem[]): Record<string, unknown> {
  return {
    code: PUSH_PROGRAM,
    dm: 'edit',
    undo_label: `sync: ${items.length} file(s)`,
    args: { op: 'push', items },
    timeout_ms: 120_000,
    wait_ms: 50_000,
  };
}

export function listRunArgs(offset: number, limit: number = LIST_PAGE): Record<string, unknown> {
  return {
    code: LIST_PROGRAM,
    dm: 'edit',
    undo_label: 'sync: list scripts',
    dry_run: true,
    args: { op: 'list', offset, limit },
    response_format: 'detailed',
    timeout_ms: 60_000,
    wait_ms: 50_000,
  };
}

export function fetchRunArgs(reqs: readonly FetchRequest[], budget: number = FETCH_BUDGET_BYTES, part: number = FETCH_PART_BYTES): Record<string, unknown> {
  return {
    code: FETCH_PROGRAM,
    dm: 'edit',
    undo_label: 'sync: read scripts',
    dry_run: true,
    args: { op: 'fetch', reqs, budget, part },
    response_format: 'detailed',
    timeout_ms: 60_000,
    wait_ms: 50_000,
  };
}

/** Bytes a batch costs on the wire: program text plus every source (the 400 KB cap is applied to this). */
export function pushBatchBytes(items: readonly PushItem[]): number {
  let bytes = Buffer.byteLength(PUSH_PROGRAM, 'utf8');
  for (const item of items) bytes += Buffer.byteLength(item.src, 'utf8') + 200;
  return bytes;
}

/**
 * Items per push program: the runtime's value serializer (§7) caps arrays at 500 entries, so a
 * larger batch would lose per-item outcomes (and its sync records) past the 500th.
 */
export const MAX_BATCH_ITEMS = 500;

/** Splits items into batches of at most `maxBytes` and MAX_BATCH_ITEMS (a single oversized file still travels alone). */
export function splitBatches(items: readonly PushItem[], maxBytes: number, maxItems: number = MAX_BATCH_ITEMS): PushItem[][] {
  const batches: PushItem[][] = [];
  let current: PushItem[] = [];
  let bytes = Buffer.byteLength(PUSH_PROGRAM, 'utf8');
  for (const item of items) {
    const cost = Buffer.byteLength(item.src, 'utf8') + 200;
    if (current.length > 0 && (bytes + cost > maxBytes || current.length >= maxItems)) {
      batches.push(current);
      current = [];
      bytes = Buffer.byteLength(PUSH_PROGRAM, 'utf8');
    }
    current.push(item);
    bytes += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
