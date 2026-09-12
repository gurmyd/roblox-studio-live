/**
 * Vision sidecar: Studio screenshots → short text answers / events through the Claude API or
 * the Claude Code CLI, so an agent can "look" without putting images in its own context and
 * "watch" continuously.
 *
 * Integration surface (see docs/vision.md): register `lookToolName` / `lookToolDescription` /
 * `lookToolShape` as an MCP tool whose handler calls `runLookTool(args, ctx)` with a
 * `VisionContext` built from the capture module, the event fan-out and the logger; call
 * `stopAllWatches()` on shutdown.
 */
export type { CaptureLike, CaptureRegion, CaptureRequest, ToolText, VisionContext, VisionEvent, VisionLogLevel, VisionProvider, VisionProviderMode } from './types.js';
export { lookToolName, lookToolDescription, lookToolShape, runLookTool, stopAllWatches, listWatches, DEFAULT_MAX_WIDTH } from './tool.js';
export {
  AUTH_HINT,
  DEFAULT_LOOK_MODEL,
  DEFAULT_WATCH_MODEL,
  FALLBACK_BETA,
  MAX_ANSWER_TOKENS,
  REQUEST_TIMEOUT_MS,
  SDK_MAX_RETRIES,
  CALL_BUDGET_MS,
  SYSTEM_PROMPT,
  MODEL_ENV,
  describeFrame,
  describeFrameWithApi,
  fallbacksEnabledFor,
  invalidModelSource,
  resolveModel,
  resetClient,
  type DescribeOptions,
  type VisionAnswer,
  type VisionFailure,
  type VisionLog,
  type VisionOutcome,
  type VisionErrorCode,
  type VisionUsage,
} from './model.js';
export {
  PROVIDER_ENV,
  PROVIDER_MODES,
  CLI_NAME,
  NO_PROVIDER_HINT,
  selectProvider,
  providerMode,
  apiCredentialInEnv,
  apiCredentialAvailable,
  findClaudeCli,
  resetProviderCache,
  cliCommand,
  type ProviderChoice,
  type ProviderSelection,
  type ProviderUnavailable,
} from './provider.js';
export {
  DEFAULT_CLI_LOOK_MODEL,
  DEFAULT_CLI_WATCH_MODEL,
  CLI_TIMEOUT_MS,
  CLI_MIN_INTERVAL_S,
  MODEL_PATTERN,
  MODEL_RULE,
  isValidModel,
  cliArgs,
  cliPrompt,
  cliModelName,
  parseCliOutput,
  classifyCliText,
  describeFrameWithCli,
} from './cli.js';
export { DIFF_THRESHOLD, frameSignature, signatureDifference, framesDiffer, type FrameSignature } from './diff.js';
export {
  WatchManager,
  compileStopWhen,
  displayModel,
  DEFAULT_INTERVAL_S,
  DEFAULT_MAX_FRAMES,
  MAX_WATCHES,
  MAX_CONSECUTIVE_ERRORS,
  type WatchSpec,
  type WatchSummary,
  type WatchEndReason,
} from './watch.js';
