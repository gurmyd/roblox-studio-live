import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BundleProvider } from './bundle.js';
import { captureStudio, listStudioWindows, shutdownCaptureWorker, warmupCaptureWorker } from './capture/index.js';
import type { BridgeConfig } from './config.js';
import { EventFanout } from './fanout.js';
import { JobStore } from './jobs.js';
import { createLogger, type Logger } from './log.js';
import { connectStdio, createMcpServer } from './mcp.js';
import { PersistStore } from './persist.js';
import { PRIMARY_NAME, ProxyToolExecutor, type PrimaryStatus } from './proxy.js';
import { startBridgeServer, type BridgeServer } from './server.js';
import { SessionRegistry } from './session.js';
import { SkillStore } from './skills.js';
import { createLocalExecutor, type CallContext, type CaptureApi, type ToolExecutor } from './tools.js';
import { stopAllWatches } from './vision/index.js';

const EXIT_GRACE_MS = 5_000;
const EXIT_DRAIN_MS = 1_500;
/**
 * On shutdown the primary keeps serving while jobs created by other processes (POST /rpc) run,
 * so closing one Claude Code window does not roll back another window's build. Bounded so a
 * hung job cannot pin the process.
 */
export const RPC_JOB_DRAIN_MS = 120_000;

export interface BridgeOptions {
  /** Screenshot backend; defaults to the PowerShell capture worker. */
  capture?: CaptureApi;
  /** Test knobs: the bridge's own give-up slack past `deadline_ms`, and ack coalescing. */
  requestGraceMs?: number;
  ackIntervalMs?: number;
}

export interface PrimaryBridge {
  mode: 'primary';
  /** Bound port; differs from `config.port` only when that was 0. */
  port: number;
  executor: ToolExecutor;
  registry: SessionRegistry;
  fanout: EventFanout;
  jobs: JobStore;
  bundle: BundleProvider;
  skills: SkillStore;
  persist: PersistStore;
  server: BridgeServer;
  status(): Record<string, unknown>;
  /** Waits (up to `maxMs`) for jobs other processes started through /rpc; returns how many were still running. */
  drainRpcJobs(maxMs: number): Promise<number>;
  close(): Promise<void>;
}

export interface ProxyBridge {
  mode: 'proxy';
  port: number;
  executor: ToolExecutor;
  primary: PrimaryStatus;
  close(): Promise<void>;
}

export type Bridge = PrimaryBridge | ProxyBridge;

/**
 * Builds the bridge without touching stdio: runtime bundle, sessions, journal fan-out,
 * tools and the HTTP/WS server — or a proxy executor when another bridge already owns
 * the port. `serve()` adds the MCP stdio transport; tests and scripts/selftest.mjs use
 * this directly on an ephemeral port.
 */
export async function createBridge(config: BridgeConfig, log: Logger, options: BridgeOptions = {}): Promise<Bridge> {
  const startedAt = Date.now();
  const jobs = new JobStore();
  const bundle = new BundleProvider({ dir: config.runtimeDir, log: log.child('bundle'), watch: config.dev });
  await bundle.load();
  // Persisted controllers live here (plugin settings are unreadable in Studio 0.738): per session in
  // memory, mirrored to <home>/persist/<placeId>.json, pushed to the hub as `persist_sync`.
  const persist = new PersistStore(config.persistDir, log.child('persist'));
  const registry = new SessionRegistry({
    bundle,
    jobs,
    log,
    persist,
    bridgeVersion: config.version,
    shippedBootstrap: config.bootstrapVersion,
    requestGraceMs: options.requestGraceMs,
    ackIntervalMs: options.ackIntervalMs,
  });
  bundle.onChange((next) => {
    registry.broadcastBundle(next);
  });
  const skills = new SkillStore(config.skillsDir, config.builtinSkillsDir);
  const fanout = new EventFanout({ registry, log });
  // Mutable so tools report the bound port when config.port was 0.
  const bridgeInfo = { version: config.version, port: config.port, bootstrapVersion: config.bootstrapVersion };
  const executor = createLocalExecutor({
    registry,
    jobs,
    skills,
    capture: options.capture ?? { captureStudio, listStudioWindows },
    log: log.child('tools'),
    bridge: bridgeInfo,
    home: config.home,
    geometryPolicy: config.geometryPolicy,
    // `vision` events reach /events sockets straight from the bridge (never the journal: seqs are the hub's).
    localEvents: (event) => {
      fanout.pushLocal(event);
    },
  });

  const status = (): Record<string, unknown> => ({
    name: PRIMARY_NAME,
    version: config.version,
    pid: process.pid,
    port: bridgeInfo.port,
    mode: 'primary',
    dev: config.dev,
    started_at: startedAt,
    uptime_ms: Date.now() - startedAt,
    bootstrap: config.bootstrapVersion,
    active: registry.active?.id ?? null,
    sessions: registry.status(),
    events_clients: fanout.size,
    jobs: { running: jobs.running().length, tracked: jobs.size },
    bundle: {
      hash: bundle.current.hash,
      entry: bundle.current.entry,
      modules: Object.keys(bundle.current.modules).length,
      dir: bundle.current.dir,
    },
  });

  const closeCore = (): void => {
    fanout.close();
    bundle.close();
    registry.close();
    jobs.close();
  };

  let started: Awaited<ReturnType<typeof startBridgeServer>>;
  try {
    started = await startBridgeServer({ port: config.port, registry, fanout, executor, status, log: log.child('http') });
  } catch (err) {
    closeCore();
    throw err;
  }

  if (started.mode === 'proxy') {
    closeCore();
    return {
      mode: 'proxy',
      port: config.port,
      executor: new ProxyToolExecutor(config.port),
      primary: started.primary,
      async close() {},
    };
  }

  bridgeInfo.port = started.server.port;
  return {
    mode: 'primary',
    port: started.server.port,
    executor,
    registry,
    fanout,
    jobs,
    bundle,
    skills,
    persist,
    server: started.server,
    status,
    async drainRpcJobs(maxMs) {
      const pending = jobs.running().filter((job) => job.origin === 'rpc');
      if (pending.length === 0) return 0;
      log.info('waiting for jobs started by other processes before shutting down', { jobs: pending.map((j) => j.id), maxMs });
      const left = await jobs.drain((job) => job.origin === 'rpc', maxMs);
      if (left.length > 0) log.warn('giving up on jobs started by other processes; they will be cancelled', { jobs: left.map((j) => j.id) });
      return left.length;
    },
    async close() {
      registry.cancelAll();
      // Watches stop before the capture worker goes away (a frame mid-capture would only log capture_failed).
      await stopAllWatches().catch((err: unknown) => log.warn('stopping vision watches failed', { err }));
      closeCore();
      await started.server.close();
      if (!options.capture) {
        await shutdownCaptureWorker().catch((err: unknown) => log.warn('capture worker shutdown failed', { err }));
      }
    },
  };
}

export interface RunningBridge {
  mode: 'primary' | 'proxy';
  port: number;
  shutdown(reason: string): Promise<void>;
}

/** Forwards to whichever executor is current, so a proxy can be promoted to primary underneath the MCP server. */
class SwitchableExecutor implements ToolExecutor {
  constructor(public current: ToolExecutor) {}

  call(name: string, args: unknown, context?: CallContext): Promise<CallToolResult> {
    return this.current.call(name, args, context);
  }
}

/** Starts the bridge (or a proxy to an existing one) and the MCP stdio server. */
export async function serve(config: BridgeConfig, log: Logger = createLogger({ level: config.logLevel })): Promise<RunningBridge> {
  let bridge = await createBridge(config, log);
  const executor = new SwitchableExecutor(bridge.executor);
  if (bridge.mode === 'proxy') {
    log.info('another studio-live bridge owns the port; running in proxy mode', {
      port: config.port,
      primaryPid: bridge.primary.pid,
      primaryVersion: bridge.primary.version,
    });
    // When the primary disappears this process takes the port over instead of dying with it.
    executor.current = new ProxyToolExecutor(config.port, {
      promote: async () => {
        const next = await createBridge(config, log);
        if (next.mode !== 'primary') {
          await next.close();
          return null;
        }
        log.info('primary bridge gone; promoted this process to primary', { port: next.port });
        bridge = next;
        executor.current = next.executor;
        void warmupCaptureWorker();
        return next.executor;
      },
    });
  } else {
    // PowerShell + the C# shim compile can take seconds and the first command another few hundred ms;
    // spawn and ping in the background now rather than inside the first screenshot.
    void warmupCaptureWorker();
  }

  const mcp = createMcpServer({ executor, version: config.version, port: config.port });
  const teardown = async (reason: string): Promise<void> => {
    log.info('shutting down', { reason, mode: bridge.mode });
    if (bridge.mode === 'primary') await bridge.drainRpcJobs(RPC_JOB_DRAIN_MS);
    const guard = setTimeout(() => process.exit(1), EXIT_GRACE_MS);
    guard.unref();
    await bridge.close();
    await mcp.close().catch(() => undefined);
    // Let libuv drain (stdin's pipe reader on Windows aborts if exit() races its close); force exit only if something lingers.
    process.exitCode = 0;
    setTimeout(() => process.exit(0), EXIT_DRAIN_MS).unref();
  };
  let closing: Promise<void> | null = null;
  const shutdown = (reason: string): Promise<void> => {
    // Assigned before the body runs: mcp.close() re-enters shutdown synchronously through onclose.
    closing ??= Promise.resolve().then(() => teardown(reason));
    return closing;
  };

  mcp.server.onclose = () => {
    void shutdown('MCP transport closed');
  };
  // The SDK's stdio transport never closes itself on EOF; treat the client hanging up as shutdown.
  process.stdin.once('end', () => {
    void shutdown('MCP client closed stdin');
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  await connectStdio(mcp);
  log.info('MCP server ready on stdio', { mode: bridge.mode, port: config.port, version: config.version });
  return { mode: bridge.mode, port: config.port, shutdown };
}
