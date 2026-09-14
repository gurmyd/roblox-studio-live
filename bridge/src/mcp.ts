import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOL_SPECS, type ToolExecutor } from './tools.js';

export const MCP_SERVER_NAME = 'studio-live';

/** ≤ 2 KB: Claude Code truncates server instructions beyond that. */
export function buildInstructions(port: number): string {
  return [
    'Studio Live connects you to a running Roblox Studio over one WebSocket. Working style:',
    '1. Ship programs, not micro-calls. One `run` call should build, query and verify a whole step against the resident S API; put loops, checks and assertions in Luau and `return` one JSON summary. From scripts pass Luau as code_file (absolute path), never via a heredoc.',
    "2. Keep the playtest alive. `playtest start` once, then iterate with `run` (dm=server|client), `playtest hotpatch` and `playtest install` controllers that run at Heartbeat in-engine. Do not stop/start per change: a restart costs ~3 s and loses play-DM state.",
    `3. Push, don't poll. Arm Monitor({ ws: { url: 'ws://127.0.0.1:${port}/events' }, persistent: true }) once; error, assert, milestone, playtest, peer, controller, job and vision events then arrive as batched frames with seq and dropped. After dropped > 0 or a seq gap, call \`events\` with since=<last seq>; without Monitor, long-poll \`events\` (timeout_ms ≤ 50000).`,
    "4. Undo semantics: edit-DM runs are ONE undo step and roll back on error. Play-DM runs are ephemeral — lost on stop, never undoable. With two Studios open, write tools require `session`. Overlapping or nested parts are reported in run.geometry — fix them before moving on; set geometry_policy 'reject' to have such runs rolled back.",
    '5. `observe tree|props|find|diff|player` are exact and cheap; use them for anything that IS state. `look {question}` answers a visual question in text (no image in your context); `look {watch}` streams `vision` events; `observe screenshot` returns the image. `input` x,y are GUI-space (AbsolutePosition) by default; gui: false means viewport pixels, NOT screenshot pixels.',
    "6. Long work returns {job_id, status:'running'} after wait_ms; use `job wait|status|cancel|list`. Save reusable programs with `skills save` and run them with `skills run`.",
    '7. `cloud`: Open Cloud for the open place; ids come from the session. Call info what:"key" first; publish before luau/instance, which read the published place.',
  ].join('\n');
}

export interface McpServerOptions {
  executor: ToolExecutor;
  version: string;
  port: number;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: options.version }, { instructions: buildInstructions(options.port) });
  for (const spec of TOOL_SPECS) {
    server.registerTool(
      spec.name,
      { title: spec.title, description: spec.description, inputSchema: spec.inputSchema, annotations: spec.annotations },
      (args, extra) => options.executor.call(spec.name, args, { origin: 'stdio', signal: extra.signal }),
    );
  }
  return server;
}

export async function connectStdio(server: McpServer): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}
