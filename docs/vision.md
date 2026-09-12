# Studio Live — vision sidecar (`look`)

The sidecar turns Studio screenshots into short **text** answers and events through a Claude vision model — the Claude API, or, without an API key, the Claude Code CLI on the user's subscription (see *Using your Claude Code login*) — so an agent can look at the screen without putting images in its own context, and can *watch* continuously (frame → vision model → text event) — the same shape Roblox's playtest agent uses. Code lives in `bridge/src/vision/`; tests in `tests/vision/`.

```
agent ──look {question}──► bridge ── capture (PrintWindow, 768 px JPEG) ──► Claude (vision) ──► {answer, usage}
agent ──look {watch}────► bridge ── every interval_s: capture → skip if unchanged → Claude ──► Monitor event {type:'vision', answer}
```

## Setup

The bridge process needs one of two things: a Claude API credential, or a logged-in Claude Code install (`claude` on PATH — the next section). With a credential the SDK's default resolution is used — nothing is configured in Studio Live itself:

| Method | How |
|---|---|
| API key | `ANTHROPIC_API_KEY=sk-ant-…` in the environment Claude Code starts the bridge with (the MCP server `env` block, or the shell) |
| OAuth token | `ANTHROPIC_AUTH_TOKEN=…` (do not set both; the API rejects requests that carry both headers) |
| Profile | `ant auth login` once on the machine; the SDK picks the profile up with no environment variable |

A `look` with neither a credential nor Claude Code answers `{error:{code:"auth", message:"no Claude API credential and no Claude Code CLI: set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) …, or run `ant auth login` …, or install/log in to Claude Code so look can use it"}}`; a watch that hits it ends at once with `reason:"error"`. The SDK client resolves its credential when it is constructed, so after an `auth` failure the sidecar drops its cached client: fix the credential and simply call `look` again — no bridge restart. Every answer and every `vision` event carries `provider: "api" | "claude-cli"` so you always know which path served it.

Models (aliases, no date suffix; the second value is the default on the `claude-cli` provider):

| Use | Default | Override |
|---|---|---|
| one-shot `look` | `claude-opus-5` / `sonnet` | `STUDIO_LIVE_VISION_MODEL` |
| `watch` worker | `claude-sonnet-5` / `haiku` | `STUDIO_LIVE_WATCH_MODEL` |
| either | — | `model` argument on the call |

Every API request: `client.beta.messages.create` with `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"` (a policy decline is re-run server-side on Anthropic's recommended fallback; the answer then reports the serving `model` and `fallback: true`), `max_tokens: 4096`, `output_config: {effort: "low"}`, a fixed system prompt ("you are the eyes of a Roblox Studio agent; describe only what is visible; say *not visible* when unsure"), one base64 image block and one text block. No prefill, no sampling parameters, no manual thinking budget — Opus 5 and Sonnet 5 think adaptively by default and those tokens count against `max_tokens`, which is why the cap is 4096 rather than the few hundred tokens a visible answer needs (`effort: low` keeps the thinking short).

`fallbacks: "default"` is sent for every model. Whether a model without a server-side fallback configuration (a `model` override such as `claude-haiku-4-5`) accepts or rejects it has not been verified against the live API; if it answers 400 the request is resent once without the parameter and the beta, a warning is logged, and that model is remembered for the rest of the process so a watch does not pay the 400 on every frame.

Time limits (the SDK defaults would be a 10-minute timeout retried twice): each attempt has a 60 s timeout and the SDK retries once (`maxRetries: 1`); a 429 is retried once more after `retry-after` (or 3 s, at most 30 s); and the whole call is cut at a 120 s budget. A watch's stop aborts the in-flight call. Exceeding a limit answers `code: "timeout"` (retryable); other errors are reported with status and message.

## Using your Claude Code login instead of an API key

No API key? If Claude Code is installed and logged in on the machine (a `claude` executable on the bridge's PATH), `look` answers through it on your subscription. Each frame runs

```
claude -p --model <model> --output-format json --allowedTools Read --strict-mcp-config --no-session-persistence
```

with the prompt on stdin: the same system prompt as the API path ("you are the eyes of a Roblox Studio agent; describe only what is visible; say *not visible* when unsure") folded into the user prompt, then `Read the image file <absolute path of the frame> and answer: <question>`. The CLI reads the JPEG with its Read tool, answers, and prints one JSON object; the sidecar maps `result` → `answer`, `duration_ms` → `model_ms`, `total_cost_usd` / `num_turns` (plus token counts when present) → `usage`, `is_error` → an error, and reports `model: "claude-cli:<model>"`, `provider: "claude-cli"`. `--strict-mcp-config` with no `--mcp-config` keeps the nested CLI from starting your MCP servers — including this bridge — on every frame, `--no-session-persistence` keeps it from writing a session file per frame under your Claude config dir, and the process runs with the frame's folder as its working directory so no project `CLAUDE.md` is loaded. It inherits the bridge's environment otherwise (so `CLAUDE_CONFIG_DIR` and user settings, including hooks, apply as they do for your own `claude` runs). A stop or the 120 s timeout kills the whole process tree, and CLI processes still alive when the bridge exits are killed with it. Output is parsed tolerantly: when stdout is not one JSON object, the last line that starts with `{` (and everything after it) is tried before giving up with `cli_bad_output`.

**Which provider answers** — `STUDIO_LIVE_VISION_PROVIDER`:

| Value | Behaviour |
|---|---|
| `auto` (default) | the API when a credential resolves without a network call — `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, or an SDK profile on disk (`ant auth login`, `ANTHROPIC_PROFILE`, `ANTHROPIC_CONFIG_DIR`); otherwise the CLI when `claude` is on PATH; otherwise `{error:{code:"auth"}}` naming both fixes |
| `api` | always the API; a missing credential fails as before |
| `claude-cli` | always the CLI; `auth` with an install hint when it is not on PATH, even if an API key is set |

The executable is resolved with `where claude` (Windows) / `which claude` (a PATH scan is the fallback), cached once found and re-probed on the next call after a miss, so installing Claude Code needs no bridge restart. The native `claude.exe` is spawned directly; an npm `.cmd`/`.bat` shim runs through `cmd /d /s /c`, a `.ps1` through PowerShell.

**What changes on the CLI path**

- *Latency*: **~10–15 s per look** (≈ 9 s of model time plus the CLI's startup and its Read-tool turn) versus **~2 s** on the API. `model_ms` is the CLI's own `duration_ms`; `wall_ms` is the whole call including startup. A call that has not returned after **120 s** is killed (the whole process tree on Windows) and reported as `code: "timeout"`, retryable; stopping a watch kills its in-flight CLI process.
- *Watch interval*: at least **15 s**. A smaller `interval_s` is raised to 15; the start result then carries `interval_clamped: {requested, min: 15}` and a `note`, and the first frame event repeats the note. As on the API, at most one CLI process runs per watch — the next capture is scheduled after the previous call finishes, never overlapping it.
- *Cost*: nothing is billed to an API account. Every frame is a Claude Code turn and **counts against the subscription's usage limits** of the logged-in account; the CLI's `total_cost_usd` estimate is passed through as `usage.cost_usd` for comparison, with `usage.turns`. A watch at 15 s is at most 240 frames an hour; with `diff_only` an idle screen still costs nothing.
- *Models*: defaults are the `sonnet` alias for a one-shot look and `haiku` for a watch (the CLI maps aliases to the current model of that family); `STUDIO_LIVE_VISION_MODEL`, `STUDIO_LIVE_WATCH_MODEL` and the `model` argument accept an alias (`haiku` | `sonnet` | `opus`) or a full id, so one variable serves both providers. A model string is validated on both providers before anything is captured — letters, digits and `. _ : @ [ ] -` only, up to 100 characters — and anything else is `bad_request` naming the argument or variable (the string is part of a command line on the CLI path, so it is never passed through unchecked). `fallbacks`, `effort` and `max_tokens` are API-only; the CLI uses its own defaults.
- *Errors*: `auth` when the CLI is not logged in (run `claude` once and log in; the next look picks it up), `bad_model` for an unknown model, `cli_error` when the process failed or reported `is_error: true` (retryable when the text looks transient — overloaded, rate limit, network), `cli_bad_output` when it exited 0 without a JSON result. A watch ends at once on `auth` / `bad_model`, as on the API.

**Environment variables**

| Variable | Values |
|---|---|
| `STUDIO_LIVE_VISION_PROVIDER` | `auto` (default) · `api` · `claude-cli` |
| `STUDIO_LIVE_VISION_MODEL` | one-shot model: an id, or an alias on the CLI (default `claude-opus-5` / `sonnet`) |
| `STUDIO_LIVE_WATCH_MODEL` | watch model (default `claude-sonnet-5` / `haiku`) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | API credential; either one makes `auto` pick the API |

Set them in the environment the bridge runs in (the MCP server `env` block or the shell); the provider is chosen on every call, so a change takes effect without a restart.

## The `look` tool

One tool, four modes; precedence when several are given: `list` → `stop` → `watch` → `question`.

### One-shot

```json
{"question": "Is there a red error line in the Output panel? Quote it.", "max_width": 768}
```

→

```json
{"answer": "Yes: \"ServerScriptService.Main:12: attempt to index nil with 'Parent'\" in red at the bottom of Output.",
 "model": "claude-opus-5", "provider": "api", "captured_ms": 34, "model_ms": 2380,
 "usage": {"input_tokens": 690, "output_tokens": 41},
 "frame_path": "C:\\Users\\me\\AppData\\Local\\Temp\\studio-live\\frames\\frame-…jpg", "width": 768, "height": 481}
```

| Argument | Meaning |
|---|---|
| `question` | what to look for; concrete visual questions work best (see below) |
| `max_width` | frame width in px, default **768** (64–2048). Vision cost is per pixel — see *Cost* |
| `region` | `{x,y,w,h}` crop in window pixels, applied before scaling (same coordinates as `observe screenshot` / `observe windows`) |
| `model` | model id override (or an alias — `haiku` / `sonnet` / `opus` — on the `claude-cli` provider) |

On the `claude-cli` provider the same answer reads `"model": "claude-cli:sonnet", "provider": "claude-cli", "model_ms": 9156, "wall_ms": 13700, "usage": {"cost_usd": 0.03, "turns": 2, …}`.

Extra fields when relevant: `requested_model` + `fallback: true` (served by a fallback), `truncated: true` + `note` (hit the 4096-token cap — `usage.output_tokens` includes thinking, and `answer` can be empty when thinking used it all; ask a narrower question or crop with `region`). Errors come back as `{error:{code, message, provider, …}}` with `isError`: `auth`, `rate_limited`, `bad_model` (404: the id is wrong or not enabled for the org), `bad_request`, `connection`, `timeout` (no answer within the limits above; retryable), `api_error` (status + message), `refusal` (with `stop_details:{category, explanation}` and any `partial_answer`), `cli_error` / `cli_bad_output` (the Claude Code CLI failed or printed no JSON result), plus the capture codes `no_window | minimized | capture_failed`.

### Watch

```json
{"watch": {"question": "Is the player's character standing on the moving platform, or has it fallen?",
           "interval_s": 5, "max_frames": 60, "stop_when": "fallen", "diff_only": true}}
```

→ `{"watch_id": "w-1", "model": "claude-sonnet-5", "provider": "api", "interval_s": 5, "max_frames": 60, "diff_only": true, "stop_when": "fallen", "max_width": 768, "note": "…"}`

| Field | Meaning |
|---|---|
| `question` | asked about every analysed frame |
| `interval_s` | seconds between captures; default 5, minimum 2, maximum 600. On the `claude-cli` provider the minimum (and default) is 15: a smaller value is raised and reported as `interval_clamped: {requested, min}` |
| `max_frames` | stop after this many **captured** frames (default 60, max 1000), so a watch lasts at most `interval_s × max_frames` seconds whatever diff_only skips |
| `stop_when` | end the watch when the answer contains this substring (case-insensitive) or matches `/pattern/flags` |
| `diff_only` | default true: frames whose bytes differ < 2 % from the last analysed frame are skipped — no model call, no event |
| `max_width`, `region`, `model` | top-level arguments apply to every frame |

The first frame is analysed immediately; the next capture is scheduled `interval_s` after the previous one **finishes**, so a watch never has more than one capture or one model call in flight. At most 4 watches run per bridge.

Each analysed frame produces one event (delivered on the `/events` Monitor socket — see *Wiring*):

```json
{"type": "vision", "watch_id": "w-1", "frame": 3, "answer": "The character is on the platform, near its left edge.",
 "changed": true, "diff": 0.42, "model": "claude-sonnet-5", "provider": "api", "model_ms": 1650,
 "usage": {"input_tokens": 640, "output_tokens": 22}, "captured_ms": 31, "frame_path": "…frame-…jpg", "at": 1789000123456}
```

(On the CLI: `"model": "claude-cli:haiku", "provider": "claude-cli", "wall_ms"`, `usage: {cost_usd, turns, …}`, and `"note"` on the first event when the interval was clamped.)

A failed frame produces `{"type":"vision","watch_id","frame","error":{"code","message","status?","stop_details?"},"provider","at"}` and the watch carries on; it gives up after **3 consecutive** failures (capture or model), and immediately on `auth` / `bad_model`. An unexpected throw inside a frame (a malformed capture result, a bug) is reported the same way with `code: "internal"` — the loop never rejects a promise, so it cannot take the bridge process down. Whatever ends it, the last event is

```json
{"type": "vision", "watch_id": "w-1", "done": true, "reason": "stop_when", "frames": 3, "analysed": 3, "skipped": 0, "errors": 0, "at": 1789000140000}
```

with `reason` ∈ `max_frames | stop_when | stopped | error`. Answers inside events are clipped to 1500 characters so a frame stays inside the 4 KB Monitor budget.

### Stop and list

- `{"stop": "w-1"}` → `{"stopped": ["w-1"]}`; an in-flight model call is aborted, no error event is emitted. Unknown id → `{error:{code:"not_found"}}`.
- `{"stop": "all"}` → `{"stopped": ["w-1", "w-2"]}`.
- `{"list": true}` → `{"watches": [{watch_id, question, model, provider, interval_s, max_frames, diff_only, stop_when, started_at, frames, analysed, skipped, errors, in_flight, last_answer, last_at}]}` — the polling fallback when Monitor is not armed.

## Cost

Image input is billed by pixels: **tokens ≈ width × height / 750**. A Studio window at 16:10 scaled to 768 px is about 768 × 480 ≈ **490 tokens**; at 1024 px ≈ 870; at 1536 px ≈ 1970. Add ~150 tokens of system prompt and question, and 20–150 output tokens for a concise answer plus whatever adaptive thinking spends at `effort: low` (hard cap 4096 for both together). Rules of thumb:

- Keep `max_width` at 768 unless you need to read small text; use `region` to zoom on a panel instead of raising the width (a 400 × 300 crop is ~160 tokens).
- A watch at `interval_s: 5` is at most 720 frames an hour; with `diff_only` an idle screen costs nothing (unchanged frames never reach the model). Budget with `max_frames`.
- The watch default is Sonnet (cheaper, fast); switch with `model` or `STUDIO_LIVE_WATCH_MODEL` when a frame needs more reasoning.
- `usage` on every answer/event is the ground truth; `frame_path` lets you pull the exact frame later with `observe screenshot` if the answer looks wrong.

### The `diff_only` approximation

The change test runs on the encoded JPEG (the base64 the capture worker already produced), not on pixels: a frame signature is the base64 length plus 128 FNV-1a hashes over 32 evenly sampled characters each (4096 samples); the difference is `max(|Δlength| / max length, differing buckets / 128)`, and a frame is "unchanged" below 2 %. Because JPEG is entropy-coded, any pixel change perturbs the byte stream from that point on, so the test is reliable at saying *unchanged* (PrintWindow of a static window re-encodes to identical bytes) and says *changed* for practically anything else. It cannot rank changes by size, and a change confined to the last rows of the image moves only the last buckets and may fall under 2 % — set `diff_only: false` when the region of interest is a bottom status bar, or `region` the capture to it.

## `look` vs `observe`

`observe tree|props|find|diff|player|logs` read the data model: exact, free, and fast. Use them for anything that *is* state — positions, properties, script text, log lines, health, whether an instance exists. Use `look` only for what pixels alone can tell:

- rendering and lighting ("does the terrain water render, or is it a flat grey plane?");
- UI layout and text as the player sees it ("is the shop button overlapping the health bar on this phone preset?");
- Studio's own UI ("which dialog is open?", "where is the Play button?" → region or pixel guess for `input`);
- the gestalt of a playtest ("is the character stuck in the wall?") when structured reads are ambiguous.

Vision is approximate: coordinates are estimates in **screenshot pixels** (window pixels ÷ `scale` from `observe screenshot`), never viewport pixels, and the model answers "not visible" when it cannot tell. Verify anything actionable with a structured read.

## Examples

Arm Monitor first so events arrive on their own (the bridge instructions already ask for this):

```
Monitor({ ws: { url: "ws://127.0.0.1:47800/events?kinds=error,assert,milestone,playtest,vision" }, persistent: true })
```

Watch a playtest for a visual failure while a controller drives the character:

```json
{"watch": {"question": "One line: is the character standing, walking, falling, or stuck inside geometry?",
           "interval_s": 4, "max_frames": 45, "stop_when": "/falling|stuck/i"}}
```

Wait for a loading screen to finish, cheaply:

```json
{"watch": {"question": "Is a loading screen or progress bar covering the viewport? Answer LOADING or READY, then one line.",
           "interval_s": 2, "max_frames": 30, "stop_when": "READY"}, "max_width": 512}
```

Zoom on the Output dock for errors after a hot-patch (region from `observe windows` / a previous screenshot):

```json
{"question": "List any red or yellow lines in this Output panel verbatim; say 'none' if there are none.",
 "region": {"x": 0, "y": 900, "w": 1600, "h": 260}, "max_width": 1024}
```

Clean up when the task is done: `{"stop": "all"}`.

## Wiring (integrator notes)

`bridge/src/vision/index.ts` exports exactly:

```ts
interface CaptureLike { path; width; height; bytes; mimeType: 'image/jpeg'|'image/png'; base64; windowTitle; captured_ms }
interface VisionContext {
  capture(opts: { maxWidth?; format?; quality?; region? }): Promise<CaptureLike>;
  emit(event: { type: 'vision'; [k: string]: unknown }): void;
  log(level: 'debug'|'info'|'warn'|'error', msg: string, data?: Record<string, unknown>): void;
}
const lookToolName: 'look'; const lookToolDescription: string /* < 2000 bytes */; const lookToolShape: Record<string, z.ZodTypeAny>;
interface ToolText { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
function runLookTool(args: unknown, ctx: VisionContext): Promise<ToolText>;
function stopAllWatches(): Promise<void>;
```

1. **Register the tool** next to the seven in `tools.ts` / `mcp.ts`: `server.registerTool(lookToolName, { title: 'Look at Studio', description: lookToolDescription, inputSchema: lookToolShape, annotations }, (args) => runLookTool(args, ctx))`. Suggested annotations: `readOnlyHint: true` (it never writes to Studio — a watch only reads), `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true` (it calls the Claude API, or spawns the Claude Code CLI which does). Keep `TOOL_NAMES`/`TOOL_SPECS` tests in sync (`tests/bridge/tools.test.ts` asserts the exact name list and the read-only set).
2. **`capture`** → `captureStudio({ maxWidth, format, quality, region })` from `bridge/src/capture/index.js`; `CaptureResult` is a superset of `CaptureLike`. `CaptureError` carries `.code` (`no_window | minimized | capture_failed`), which the tool surfaces unchanged.
3. **`emit`** → deliver to `/events` sockets. Journal seqs are assigned by the hub and `Journal.ingest` drops anything `≤ latest`, so **never ingest a bridge-made event with a synthetic seq** (the next hub event would be deduped away). Add a `pushLocal(ev)` on `EventFanout` that calls `client.push` on every attached client, stamping `{ v: 1, kind: 'ev', seq: <target session's journal.latestSeq>, t, wall: Date.now(), src: 'bridge', ...event }` so no `seq` gap is signalled. Also add `vision` to the default forwarded kinds (fanout / `makeFilter` defaults), or the agent must open the socket with `?kinds=…,vision`. Vision events are not journaled, so `events` backfill does not return them — `look {list:true}` (`last_answer`) is the polling fallback.
4. **`log`** → `log.child('vision')` mapped level by level (`Logger` in `log.ts` has the same four methods).
5. **Shutdown** → `await stopAllWatches()` in `Bridge.close()` before the capture worker is shut down (a watch mid-capture otherwise sees `capture_failed` and logs a warning; harmless, just noisy).
6. **Proxy mode**: `runLookTool` runs wherever the tool executes; a secondary bridge that proxies through `POST /rpc` runs watches on the primary, which is what you want (one capture worker, one event fan-out).
7. Server instructions (`buildInstructions`, ≤ 2 KB): add one clause to item 5 — "`look {question}` gives a text answer from a vision model; `look {watch}` streams `vision` events" — so the agent knows the tool exists without reading its description.

## Verifying

- Unit: `npx vitest run tests/vision` (78 tests, no network: the SDK is mocked, and the CLI provider runs against a fake `claude` — a node script behind a `claude.cmd` / `claude` shim in a temp dir put first on PATH — covering provider selection, success, `is_error`, non-JSON output, timeout/kill, abort and the watch clamp). Typecheck in isolation with a scratch tsconfig extending the root one and `include: ["bridge/src/vision/*.ts"]`.
- Live smoke, once wired: with Studio open and a credential set, `look {question: "What is visible? One line."}` should answer in 1–4 s with `provider: "api"` and `usage.input_tokens` around 600–800 at the default width; `look {watch: {question: "…", interval_s: 2, max_frames: 3}}` should produce three `vision` events on the Monitor socket and a `done` event with `reason: "max_frames"`; `look {watch: …}` on a static screen should show `skipped` climbing in `look {list: true}` with no new model calls.
- Live smoke on the CLI: with no `ANTHROPIC_*` credential and `claude` logged in, the same one-shot `look` should answer in 10–15 s with `provider: "claude-cli"`, `model: "claude-cli:sonnet"`, `model_ms` ≈ 9000 and `usage: {cost_usd, turns: 2, …}`; a watch with `interval_s: 2` should start with `interval_s: 15` and `interval_clamped`, and `STUDIO_LIVE_VISION_PROVIDER=api` should bring the `auth` error back.
