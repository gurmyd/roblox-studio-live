# Installing Studio Live

Windows 11, Node.js ≥ 20 (24 tested), Roblox Studio (0.738 tested), Claude Code with MCP support. Nothing here touches Studio's own settings files or other plugins.

## 1. Build

```powershell
cd <this repo>
npm install
npm run build
```

`build` runs three steps:

1. `tsc` compiles `bridge/src` into `dist/`.
2. `scripts/copy-assets.mjs` copies `bridge/src/capture/worker.ps1` next to the compiled capture module (the screenshot worker is PowerShell, not TypeScript).
3. `scripts/pack-plugin.mjs` packs `plugin/bootstrap.luau` into `dist/StudioLive.rbxmx` (a Roblox XML model with one `Script` named `StudioLive`) and mirrors it as `dist/StudioLive.lua`. If the bootstrap is missing it prints a warning and writes `dist/StudioLive.NOT_PACKED.txt` instead of a broken plugin.

## 2. Install the plugin into Studio

```powershell
npm run install:studio
```

This copies `dist/StudioLive.rbxmx` to `%LOCALAPPDATA%\Roblox\Plugins\StudioLive.rbxmx`, creating the folder if needed, backing up any previous `StudioLive.rbxmx` to `StudioLive.rbxmx.bak`, and deleting a stale `StudioLive.lua` if one is present (Studio would otherwise load the plugin twice). It then prints the next steps with the absolute paths filled in.

Manual alternative: copy `dist\StudioLive.rbxmx` into `%LOCALAPPDATA%\Roblox\Plugins` yourself. Do not install both the `.rbxmx` and the `.lua`.

## 3. Restart Roblox Studio — once

Studio's edit DataModel enumerates the local plugins folder only when it starts; a file dropped there while Studio is running is never loaded (measured: a new plugin file sat there for over 10 s without a `PluginLoadingEnhanced` log line). Close Studio and open your place again.

Why this is the *only* restart you will ever need: the file on disk is a tiny **bootstrap**. It knows how to connect to the bridge, receive the runtime bundle over the WebSocket, and start it. Every later version of the runtime is delivered by the bridge at connect time, and a bundle with a new hash replaces the running one in place (`runtime.stop()` → start the new bundle). Playtest DataModels get the bundle from the edit DataModel over `PluginConnectionService`. You restart Studio again only if `plugin/bootstrap.luau` itself changes: the bridge compares the version the connecting bootstrap announces with the one it ships and, when the installed one is older, logs a warning and reports it as `bridge.bootstrap.outdated` in `observe status` and `sessions[].bootstrapOutdated` in `GET /status`.

## 4. Check one Studio setting

*File → Studio Settings → Studio → **Load User Plugins In Run Modes*** must be **on**. Studio's "Faster Play Solo" keeps user plugins out of play/run DataModels unless this is set, and without it there are no `server`/`client` peers for the `playtest`, `input` and controller features. Edit-DataModel features work regardless.

## 5. Register the MCP server

The install step prints this line with the real absolute path:

```powershell
claude mcp add studio -- node "<repo>\dist\bridge\cli.js" serve
```

Use `--scope user` to make it available in every project, or run it inside the project you want it in. `claude mcp list` should show `studio` as connected.

## 6. Permissions

Add to `.claude/settings.json` (project) or `~/.claude/settings.json` (user):

```json
{
  "permissions": {
    "allow": ["mcp__studio__*", "Monitor"]
  }
}
```

`mcp__studio__*` approves the nine tools without prompts; `Monitor` lets the agent arm the push socket without a prompt each session. An unanchored `mcp__*` glob is ignored by Claude Code, so name the server.

## 7. First session

1. Open a place in Studio. The bootstrap connects to `ws://127.0.0.1:47800/studio` within a second and the bridge pushes the runtime.
2. In Claude Code, arm push once per session:
   `Monitor({ ws: { url: 'ws://127.0.0.1:47800/events' }, persistent: true })`
   Assertion failures, errors, warnings, milestones, playtest and peer changes now land in the model's context as they happen.
3. Ask for something: `observe { what: "status" }` reports the session, the connected DataModels (`peers`), the running playtest, and the capabilities (`loadstring`, `virtualInput`, `capture`).
4. Try a screenshot: `observe { what: "screenshot" }` returns a 1024-px JPEG in ~100 ms even when Studio is behind other windows.

## Updating

`npm run build` again. The runtime changes take effect the next time Studio connects to the bridge (restart the bridge, or wait for the reconnect). Only a changed `plugin/bootstrap.luau` — or a changed `STUDIO_LIVE_PORT` — requires `npm run install:studio` and a Studio restart.

## Uninstalling

Delete `%LOCALAPPDATA%\Roblox\Plugins\StudioLive.rbxmx` (and the `.bak`), run `claude mcp remove studio`, and remove the permission entries. Frames captured by the screenshot tool live in `%TEMP%\studio-live\frames` (the newest 200 are kept) and can be deleted at any time.

## Ports and coexistence

The bridge listens on `127.0.0.1:47800` and `[::1]:47800`. `STUDIO_LIVE_PORT` overrides the bridge; the plugin reads no settings, so the port is **baked into the plugin at install time**: run `npm run install:studio` (or `studio-live install`) with the variable set, restart Studio once, and register the MCP server with `claude mcp add studio --env STUDIO_LIVE_PORT=<port> -- node "…\cli.js" serve` (the install output prints it). Other Studio connectors on this machine (the official StudioMCP on 13469, the community plugin on 58741, Rojo) use their own ports and their own `PluginConnection` identities, so they coexist. A second `studio-live` process (a second Claude Code window) detects the primary on the port and proxies its tool calls to it over `POST /rpc` instead of opening a second Studio connection; when the primary shuts down it waits for jobs the second process started (up to two minutes) before cancelling anything, and the second process promotes itself to primary on its next call.
