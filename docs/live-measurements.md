# Live measurements — Roblox Studio 0.738.0.7381393, Windows 11, 2026-09-10/11

Everything below was measured on this machine against an open Team Create place, using throwaway Luau run through the community MCP's `execute_luau` plus a local Node WebSocket server. Numbers are wall-clock from `os.clock()` inside Studio or `process.hrtime` in Node.

## 1. Transport: plugin ⇄ local process

| Path | Result |
|---|---|
| `HttpService:CreateWebStreamClient(WebSocket, {Url="ws://localhost:PORT"})` from **edit** DM | works, `Opened(200)` after 15 ms, no permission prompt (`HttpEnabled` true) |
| same from **play-server** DM | works (open 16 ms) |
| same from **play-client** DM | works (open 16 ms) |
| Studio → server → Studio echo RTT, sequential | p50 16.5 ms, max 17.7 ms (= exactly one Heartbeat frame; message delivery is frame-quantised) |
| 200 echoes fired in one frame | all answered in the next frame (p50 18.3 ms) |
| server → Studio push RTT (server-initiated) | p50 16.8 ms |
| 2000 `ws:Send` calls in one frame | 5.2 ms total |
| 64 KB / 1 MB / 4 MB server→Studio messages | 17 / 20 / 42 ms |
| 1 MB Studio→server message | delivered intact |
| `HttpService:RequestAsync` GET to localhost | p50 16.6 ms (same frame-quantisation) |
| Heartbeat interval, edit and play, window unfocused | p50 16.6 ms (Studio keeps ticking at 60 Hz while minimised/occluded) |
| streaming 1 JSON state msg per Heartbeat from play-server for 2 s | 121 msgs, encode 0.014 ms each, **no frame-time impact** (p50 16.59 → 16.59 ms) |

Conclusion: the ~250 ms average / 500 ms worst-case that the community plugin adds by polling every 0.5 s is pure transport waste. A persistent WebSocket per DataModel gives ~1 frame (16 ms) each way, and Studio can hold one from all three DMs at once.

Handshake headers Studio sends: `User-Agent: RobloxStudio/WinInet RobloxApp/0.738.0.7381393`, plus a W3C `traceparent`. Only `ws://` was tested; TLS not needed for loopback.

## 2. Code execution

| Path | Result |
|---|---|
| `loadstring` in plugin context (edit, server, client) | available; 500-line chunk compiles in 1.15 ms, runs in 0.004 ms |
| fresh `ModuleScript.Source = …; require()` from plugin (server DM) | works (returned 42) |
| **hot-inject `Script` into running play-server** (`ServerScriptService`) | ran within **16.6 ms**, saw 1 player |
| **hot-inject `LocalScript` into running play-client** (`PlayerGui`) | ran within **16.9 ms** |
| `workspace:StepPhysics(1)` from plugin in edit mode | allowed, 0.05 ms on an empty place |

Conclusion: a live playtest can be treated as a long-running sandbox; new server/client code lands in the next frame with no restart.

## 3. Playtest lifecycle (from Studio's own `WaypointTelemetry` in the Studio log)

`StudioTestService:ExecutePlayModeAsync({})` on this near-empty place:

| Waypoint | ms since start |
|---|---|
| PSMServerCreated | 17 |
| PSMClientCreated | 26 |
| PSMServerLoadedCB | 224 |
| PSMServerRanCB | 605 |
| PSMClientLoadingFinished | 838 |
| PlaySoloLoadingFinished (IDE doc) | 972 |
| **PSMCharacterAdded** | **1 994** |

Stop (`EndTest` from the server DM): StopPlaySoloEnd at **704 ms** (DM shutdown 657 ms of that). Plugins are unloaded/reloaded in every DM on each cycle (19 plugins, 10 ms).

Conclusion: a full restart costs ≈ 2.7 s. That is acceptable occasionally but must not be the inner loop — keep the session alive and hot-inject.

Note: Studio does **not** load a newly dropped file in `%LOCALAPPDATA%\Roblox\Plugins` while running (a new `.lua` sat there for >10 s with no `PluginLoadingEnhanced` log line). Install once; iterate plugin logic by fetching code from the local server, not by rewriting the plugin file.

## 4. Observation

| Path | Result |
|---|---|
| `CaptureService:CaptureScreenshot` while Studio minimised | callback never fires (5 s timeout) — matches the community plugin's warning |
| same with window restored but occluded behind other windows | 649 ms first, 592 ms second → ≈1.5 fps ceiling |
| `AssetService:CreateEditableImageAsync(Content.fromUri(id))` + `ReadPixelsBuffer` | 32 ms + 2 ms, 1428×1181 RGBA = 6.7 MB raw |
| `EncodingService:CompressBuffer(Zstd,1)` / `Base64Encode` of that | 18 ms → 2.75 MB; 5 ms → 3.67 MB (raw RGBA compresses poorly; Studio has no JPEG/PNG encoder) |
| **Win32 `PrintWindow` on the Studio HWND from Node/PowerShell** | **28–44 ms**, full 1734×1399 image, works while occluded (not while minimised); PNG encode 5 ms |
| full DataModel snapshot from play-server (2 381 instances: class/name/debugId/pos/size) | walk 2.6 ms + JSON 0.55 ms = 114 KB |
| `GetPropertyChangedSignal("Position")` on all 27 parts + `DescendantAdded` for 1 s | zero overhead when idle; usable as a change stream |
| LogService.MessageOut in play DMs | fires for hot-injected script prints (used above) |

Conclusion: screenshots should come from the OS side (30 fps possible, no engine round-trip) with the in-engine capture as fallback; structured snapshots/diffs are ~3 ms and should be the primary "vision" channel.

## 5. Human-like input (play-client DM, plugin context)

| API | Result |
|---|---|
| `VirtualInputManager:SendKeyEvent` | **blocked**: "lacking capability RobloxScript" |
| `UserInputService:CreateVirtualInput()` | **works** (returns Object). Six methods (API dump 0.738): `SendKey(isPressed, keyCode, isRepeatedKey?)`, `SendMouseButton(position, button, isDown, repeatCount?)`, `SendMouseDelta(positionDelta)`, `SendMousePosition(position)`, `SendPointerAction(position, pointerAction: {[string]: any})`, `SendTextInput(text)`. (An earlier probe only checked three names; all six are present and callable.) |
| `vi:SendKey(true, W)` 0.6 s | character moved 9.78 studs via the real control module, `UserInputService.InputBegan` fired |
| `vi:SendKey(Space)` | Humanoid jumped |
| `vi:SendMouseButton(pos, MouseButton1, down/up)` on a TextButton | `Activated` fires when `pos` = AbsolutePosition + size/2 **+ GuiInset (0,58)**; without the inset it misses |
| `vi:SendMousePosition(Vector2(600,450))` | `UserInputService:GetMouseLocation()` went (-1,-1) → (600,450); `InputChanged` MouseMovement fired |
| `vi:SendMouseDelta(Vector2(300,0))` with `UIS.MouseBehavior = LockCenter` set 0.1 s earlier | camera LookVector changed by 1.87 (rotated); `InputChanged` carried delta (300,0). Without LockCenter it throws "cursor is not locked" |
| `vi:SendTextInput("hello agent")` into a focused TextBox | TextBox.Text == "hello agent" |
| `vi:SendPointerAction(...)` | first arg is a `Vector2` position, second a dictionary (guesses with other shapes error "Unable to cast … to Dictionary"). Measured later (v1.1): it accepts **any** dictionary and produces **no `MouseWheel` input events** — scroll cannot be synthesised (see §7) |
| `Humanoid:Move(dir, true)` fallback | moved 6.21 studs in 0.5 s |

Conclusion: keyboard, mouse buttons, absolute mouse position, relative look (cursor locked) and text can all be driven through the genuine input pipeline from the play-client plugin VM. Scroll is not reachable at all (`SendPointerAction` is inert). Relative look works when the delta is sent a frame *after* `MouseBehavior = LockCenter` (the `input` tool's `look` action does this and verifies the camera rotated — 34 ms live); sending it in the same frame errors "cursor is not locked".

## 6. Existing connectors (for the root-cause comparison)

- **Community `@chrrxs/robloxstudio-mcp` 2.23.1**: plugin polls `GET /poll` every 0.5 s from a Heartbeat-driven loop; each play-DM peer and each client proxy polls separately; stop-playtest is signalled via `plugin:SetSetting` polled at 1 s; MCP request timeout ≤ 300 s.
- **Official `StudioMCP.exe`** (Rust, rmcp 2.2.0 + axum): Studio connects to it over WebSocket on 127.0.0.1:13469, so its transport is already push-based; the slowness is the one-small-tool-per-LLM-turn model, not the wire.

## 7. Known engine facts (Studio 0.738) — design constraints, not bugs to retry

> - **`plugin:GetSetting` returns `nil` for every key in this build.** Measured 2026-09-11: immediately after `plugin:SetSetting(k, v)` in the same DataModel, again 1 s later, and for keys another installed plugin had written. Plugin settings cannot persist anything; Studio Live keeps durable state (persisted controllers) in the bridge (`<STUDIO_LIVE_HOME>/persist/<placeId>.json`) and never reads settings in the runtime.
> - **`VirtualInput:SendPointerAction(position, dict)` produces no scroll.** It accepts any dictionary and emits no `MouseWheel` input events. There is no `scroll` input action; scroll a `ScrollingFrame` by setting `CanvasPosition` from a `run` on the client.
> - **`workspace:StepPhysics(n)` advances one step per frame.** N steps cost N Heartbeat frames of wall time (≈ N/60 s) regardless of `dt`, so a physics settle of `seconds` at `dt` needs `ceil(seconds/dt)/60` s of real time; the builtin `settle_physics` sizes its work by `S.remaining()` and refuses up front when `timeout_ms` cannot cover it, rather than timing out and rolling every position back.
