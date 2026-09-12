# Studio Live — instructions for coding agents

Roblox Studio is driven through the `studio` MCP tools. Read [docs/agent-guide.md](docs/agent-guide.md) first; it is the working style plus worked examples for every tool.

Project rules:
- `plugin/bootstrap.luau` is installed in Studio and must not change; `dist/StudioLive.rbxmx` must stay 18515 chars of Luau. Runtime lives in `plugin/runtime/**` and is delivered live on every bridge connect.
- Bridge stdout is the MCP transport — log to stderr only.
- Tests must never bind port 47800; use `scripts/fake-hub.mjs`.
- Never print an Open Cloud key (`~/.studio-live/opencloud.key`, `ROBLOX_OPEN_CLOUD_KEY`).
- After runtime edits: `npm run luau:check`, restart the bridge, then `observe what=selftest`.
