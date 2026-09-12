import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { errorResult, isCallToolResult } from './result.js';
import type { CallContext, ToolExecutor } from './tools.js';

export const PRIMARY_NAME = 'studio-live';
const PROBE_TIMEOUT_MS = 1_500;
/** Tool calls wait up to 50 s themselves; leave room for the primary to answer after that. */
const RPC_TIMEOUT_MS = 90_000;

export interface PrimaryStatus {
  name: typeof PRIMARY_NAME;
  version: string | null;
  pid: number | null;
  port: number | null;
  raw: Record<string, unknown>;
}

/** Accepts a `/status` body only when it announces itself as a studio-live bridge. */
export function parsePrimaryStatus(body: string): PrimaryStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.name !== PRIMARY_NAME) return null;
  return {
    name: PRIMARY_NAME,
    version: typeof raw.version === 'string' ? raw.version : null,
    pid: typeof raw.pid === 'number' ? raw.pid : null,
    port: typeof raw.port === 'number' ? raw.port : null,
    raw,
  };
}

export type ProbeResult =
  | { state: 'healthy'; status: PrimaryStatus }
  | { state: 'other'; detail: string }
  | { state: 'unreachable'; detail: string };

export interface ProbeOptions {
  host?: string;
  timeoutMs?: number;
}

/** GET /status on the port; distinguishes a healthy bridge from a foreign listener and from nothing at all. */
export async function probePrimary(port: number, options: ProbeOptions = {}): Promise<ProbeResult> {
  const host = options.host ?? '127.0.0.1';
  const url = `http://${host}:${port}/status`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS) });
  } catch (err) {
    return { state: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
  }
  const body = await response.text().catch(() => '');
  if (!response.ok) return { state: 'other', detail: `GET ${url} → HTTP ${response.status}` };
  const status = parsePrimaryStatus(body);
  if (!status) return { state: 'other', detail: `GET ${url} answered but is not a studio-live bridge` };
  return { state: 'healthy', status };
}

export interface RpcOptions {
  host?: string;
  timeoutMs?: number;
  /**
   * Called once when the primary stops answering: tries to become the primary and returns the
   * executor to use from then on (null when the port is still taken). Set by app.serve().
   */
  promote?: () => Promise<ToolExecutor | null>;
}

/** POST /rpc {tool,args} on the primary; resolves with the primary's CallToolResult. */
export async function rpcCall(port: number, tool: string, args: unknown, options: RpcOptions = {}): Promise<CallToolResult> {
  const host = options.host ?? '127.0.0.1';
  const response = await fetch(`http://${host}:${port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, args: args ?? {} }),
    signal: AbortSignal.timeout(options.timeoutMs ?? RPC_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return errorResult('internal', `primary bridge returned non-JSON for ${tool} (HTTP ${response.status})`);
  }
  if (isCallToolResult(parsed)) return parsed;
  const message = typeof parsed === 'object' && parsed !== null && 'error' in parsed ? JSON.stringify((parsed as { error: unknown }).error) : text.slice(0, 500);
  return errorResult('internal', `primary bridge rejected ${tool}: HTTP ${response.status} ${message}`);
}

/**
 * Secondary-process executor: forwards every tool call to the primary bridge on the same port.
 * When the primary goes away it promotes itself (via `promote`) and serves the call locally.
 */
export class ProxyToolExecutor implements ToolExecutor {
  private promoted: ToolExecutor | null = null;
  private promoting: Promise<ToolExecutor | null> | null = null;

  constructor(
    private readonly port: number,
    private readonly options: RpcOptions = {},
  ) {}

  async call(name: string, args: unknown, context?: CallContext): Promise<CallToolResult> {
    if (this.promoted) return this.promoted.call(name, args, context);
    let failure: string;
    try {
      return await rpcCall(this.port, name, args, this.options);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    const local = await this.tryPromote();
    if (local) return local.call(name, args, context);
    return errorResult(
      'proxy_unreachable',
      `primary studio-live bridge on port ${this.port} did not answer (${failure}) and this process could not take the port over; restart this MCP server`,
    );
  }

  private tryPromote(): Promise<ToolExecutor | null> {
    if (this.promoted) return Promise.resolve(this.promoted);
    if (!this.options.promote) return Promise.resolve(null);
    // Concurrent calls share one promotion attempt.
    this.promoting ??= this.options.promote().then(
      (executor) => {
        this.promoted = executor;
        this.promoting = null;
        return executor;
      },
      () => {
        this.promoting = null;
        return null;
      },
    );
    return this.promoting;
  }
}
