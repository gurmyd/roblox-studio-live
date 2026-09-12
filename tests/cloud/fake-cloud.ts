import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Minimal stand-in for apis.roblox.com: records every request (method, path,
 * query, headers, body) and answers with whatever the current handler returns.
 */
export interface SeenRequest {
  n: number;
  method: string;
  path: string;
  url: URL;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
  text: string;
  json: unknown;
  formData(): Promise<FormData>;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export type Handler = (req: SeenRequest) => Reply | Promise<Reply>;

export interface FakeCloud {
  url: string;
  seen: SeenRequest[];
  respond(handler: Handler): void;
  reset(): void;
  close(): Promise<void>;
}

const DEFAULT_HANDLER: Handler = () => ({ status: 200, body: {} });

export async function startFakeCloud(): Promise<FakeCloud> {
  let handler: Handler = DEFAULT_HANDLER;
  const seen: SeenRequest[] = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const text = raw.toString('utf8');
    let json: unknown;
    if (text !== '' && (req.headers['content-type'] ?? '').includes('json')) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    const url = new URL(req.url ?? '/', 'http://fake.local');
    const item: SeenRequest = {
      n: seen.length + 1,
      method: req.method ?? 'GET',
      path: url.pathname,
      url,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      raw,
      text,
      json,
      formData: () => new Response(raw, { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData(),
    };
    seen.push(item);

    let reply: Reply;
    try {
      reply = await handler(item);
    } catch (err) {
      reply = { status: 500, body: { message: err instanceof Error ? err.message : String(err) } };
    }
    const headers: Record<string, string> = { ...(reply.headers ?? {}) };
    let payload = '';
    if (reply.body !== undefined) {
      if (typeof reply.body === 'string') {
        payload = reply.body;
        headers['content-type'] ??= 'text/plain';
      } else {
        payload = JSON.stringify(reply.body);
        headers['content-type'] ??= 'application/json';
      }
    }
    res.writeHead(reply.status ?? 200, headers);
    res.end(payload);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    respond: (next) => {
      handler = next;
    },
    reset: () => {
      seen.length = 0;
      handler = DEFAULT_HANDLER;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
