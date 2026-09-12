import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { BridgeError, errorCode, errorMessage } from './errors.js';
import { DEFAULT_PUSH_FILTER, parseFilterQuery, type EventFanout } from './fanout.js';
import { DEFAULT_BACKFILL_LIMIT, MAX_BACKFILL_LIMIT, NO_FILTER } from './journal.js';
import { MAX_JOB_WAIT_MS } from './jobs.js';
import type { Logger } from './log.js';
import { probePrimary, type PrimaryStatus } from './proxy.js';
import type { SessionRegistry } from './session.js';
import type { ToolExecutor } from './tools.js';

const DEFAULT_LONG_POLL_MS = 25_000;
const MAX_RPC_BODY_BYTES = 16 * 1024 * 1024;
const MAX_WS_PAYLOAD_BYTES = 64 * 1024 * 1024;
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;

export interface BridgeServerDeps {
  port: number;
  registry: SessionRegistry;
  fanout: EventFanout;
  executor: ToolExecutor;
  status: () => Record<string, unknown>;
  log: Logger;
}

export interface BridgeServer {
  readonly port: number;
  readonly addresses: readonly string[];
  close(): Promise<void>;
}

export type StartResult = { mode: 'primary'; server: BridgeServer } | { mode: 'proxy'; primary: PrimaryStatus };

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function intParam(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new BridgeError('bad_request', `query parameter ${name} must be a number`);
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BridgeError('bad_request', `request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function remoteOf(req: http.IncomingMessage): string {
  return `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`;
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function createRequestHandler(deps: BridgeServerDeps): http.RequestListener {
  const { registry, executor, log } = deps;

  const handleLongPoll = async (url: URL, res: http.ServerResponse): Promise<void> => {
    const params = url.searchParams;
    const since = intParam(params, 'since', 0, 0, Number.MAX_SAFE_INTEGER);
    const timeout = intParam(params, 'timeout', DEFAULT_LONG_POLL_MS, 0, MAX_JOB_WAIT_MS);
    const limit = intParam(params, 'limit', DEFAULT_BACKFILL_LIMIT, 1, MAX_BACKFILL_LIMIT);
    const filter = parseFilterQuery(params, NO_FILTER);
    const session = registry.resolve(params.get('session'), { allowDisconnected: true });
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const backfill = await session.journal.waitFor(since, filter, timeout, limit, abort.signal);
    if (res.destroyed) return;
    sendJson(res, 200, {
      session: session.id,
      cursor: backfill.cursor,
      events: backfill.events,
      dropped: backfill.dropped,
      truncated: backfill.truncated,
      hub_dropped: session.hb?.dropped ?? 0,
    });
  };

  const handleRpc = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // /rpc runs Luau in the user's Studio: refuse anything a browser page could send cross-origin.
    if (req.headers.origin !== undefined) {
      sendError(res, 403, 'forbidden', '/rpc does not accept browser-originated requests');
      return;
    }
    if (!(req.headers['content-type'] ?? '').includes('application/json')) {
      sendError(res, 415, 'bad_request', '/rpc requires content-type: application/json');
      return;
    }
    const text = await readBody(req, MAX_RPC_BODY_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendError(res, 400, 'bad_request', '/rpc body is not valid JSON');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { tool?: unknown }).tool !== 'string') {
      sendError(res, 400, 'bad_request', '/rpc body must be {"tool": string, "args": object}');
      return;
    }
    const { tool, args } = parsed as { tool: string; args?: unknown };
    sendJson(res, 200, await executor.call(tool, args ?? {}, { origin: 'rpc' }));
  };

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = `${req.method ?? 'GET'} ${url.pathname}`;
    const run = async (): Promise<void> => {
      switch (route) {
        case 'GET /status':
          sendJson(res, 200, deps.status());
          return;
        case 'GET /events':
          await handleLongPoll(url, res);
          return;
        case 'POST /rpc':
          await handleRpc(req, res);
          return;
        default:
          sendError(res, 404, 'not_found', `no route ${route}`);
      }
    };
    run().catch((err: unknown) => {
      const code = errorCode(err);
      const status = code === 'bad_request' ? 400 : code === 'no_session' || code === 'disconnected' ? 503 : 500;
      if (status === 500) log.error('request failed', { route, err });
      if (!res.headersSent) sendError(res, status, code, errorMessage(err));
      else res.destroy();
    });
  };
}

/**
 * Binds HTTP+WS on 127.0.0.1 (required) and ::1 (best effort). When 127.0.0.1
 * is taken by a healthy studio-live bridge the caller should run in proxy mode;
 * any other listener is a hard error.
 */
export async function startBridgeServer(deps: BridgeServerDeps): Promise<StartResult> {
  const { registry, fanout, log } = deps;
  const handler = createRequestHandler(deps);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
  const servers: http.Server[] = [];
  const addresses: string[] = [];

  const makeServer = (): http.Server => {
    const server = http.createServer(handler);
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/studio') {
        wss.handleUpgrade(req, socket, head, (ws) => registry.attach(ws, remoteOf(req)));
      } else if (url.pathname === '/events') {
        const filter = parseFilterQuery(url.searchParams, DEFAULT_PUSH_FILTER);
        // A socket is pinned to the session active when it attached, so its seq space never mixes two hubs.
        const session = url.searchParams.get('session') ?? registry.active?.id ?? null;
        wss.handleUpgrade(req, socket, head, (ws) => {
          fanout.attach(ws, filter, session);
        });
      } else {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
    });
    return server;
  };

  const [v4Host, v6Host] = LOOPBACK_HOSTS;
  const v4 = makeServer();
  try {
    await listen(v4, v4Host, deps.port);
  } catch (err) {
    const bindError = err as NodeJS.ErrnoException;
    if (bindError.code !== 'EADDRINUSE') {
      throw new BridgeError('bind_failed', `cannot listen on ${v4Host}:${deps.port}: ${bindError.message}`);
    }
    const probe = await probePrimary(deps.port);
    if (probe.state === 'healthy') {
      wss.close();
      return { mode: 'proxy', primary: probe.status };
    }
    throw new BridgeError(
      'port_in_use',
      `port ${deps.port} is in use by something that is not a studio-live bridge (${probe.detail}); stop that program, or set STUDIO_LIVE_PORT to a free port for the bridge AND run "studio-live install" again with it set (the port is baked into the plugin), then restart Studio`,
    );
  }
  servers.push(v4);
  const port = (v4.address() as AddressInfo).port;
  addresses.push(`${v4Host}:${port}`);

  const v6 = makeServer();
  try {
    await listen(v6, v6Host, port);
    servers.push(v6);
    addresses.push(`[${v6Host}]:${port}`);
  } catch (err) {
    log.warn('IPv6 loopback unavailable; listening on IPv4 only', { err });
  }
  log.info('bridge listening', { addresses });

  return {
    mode: 'primary',
    server: {
      port,
      addresses,
      async close() {
        for (const client of wss.clients) client.terminate();
        wss.close();
        await Promise.all(servers.map(closeServer));
      },
    },
  };
}
