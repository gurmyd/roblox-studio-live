/**
 * Vision sidecar contract. The bridge integrator supplies a `VisionContext` (capture, event
 * sink, logger); the sidecar never touches the capture worker, the journal or stdio itself.
 */

/** What the sidecar needs from a screenshot; `CaptureResult` from ../capture satisfies it. */
export interface CaptureLike {
  path: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: 'image/jpeg' | 'image/png';
  base64: string;
  windowTitle: string;
  captured_ms: number;
}

export interface CaptureRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CaptureRequest {
  maxWidth?: number;
  format?: 'jpeg' | 'png';
  quality?: number;
  region?: CaptureRegion;
}

/**
 * Which backend answers a question: the Claude API through the SDK (`api`) or the Claude Code
 * CLI on the user's subscription (`claude-cli`). Selection rules are in provider.ts.
 */
export type VisionProvider = 'api' | 'claude-cli';
/** STUDIO_LIVE_VISION_PROVIDER: a fixed provider, or `auto` (API when a credential resolves, else the CLI). */
export type VisionProviderMode = VisionProvider | 'auto';

/** Every event the sidecar emits carries `type: 'vision'`; the other fields are documented in docs/vision.md. */
export interface VisionEvent {
  type: 'vision';
  [k: string]: unknown;
}

export type VisionLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface VisionContext {
  capture(opts: CaptureRequest): Promise<CaptureLike>;
  emit(event: VisionEvent): void;
  log(level: VisionLogLevel, msg: string, data?: Record<string, unknown>): void;
}

/** Text-only MCP tool result (structurally a CallToolResult without image blocks). */
export interface ToolText {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
