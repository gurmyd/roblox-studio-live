/**
 * Roblox Open Cloud module — public surface.
 *
 * The integrator registers one MCP tool:
 *   server.tool(cloudToolName, cloudToolDescription, cloudToolShape, (args) => runCloudTool(args, ctx))
 * where `ctx.ids()` returns the ids of the active Studio session (universe = game.GameId,
 * place = game.PlaceId, creator = place owner) or null, `ctx.log` is the bridge logger,
 * and `ctx.home` is STUDIO_LIVE_HOME (holds opencloud.json / opencloud.key).
 */
export type { CloudContext, CloudIds, ToolText } from './types.js';
export { cloudToolDescription, cloudToolName, cloudToolShape } from './schema.js';
export { runCloudTool } from './run.js';
