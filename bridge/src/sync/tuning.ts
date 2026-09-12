/**
 * Timing knobs. The public SyncOptions is fixed by contract, so tests shorten these
 * instead of adding options; production values are the documented ones (docs/sync.md).
 */
export const SYNC_TUNING = {
  /** fs.watch quiet period before a batch is pushed. */
  debounceMs: 200,
  /** Pull mode: interval between checksum polls of the DataModel. */
  pollMs: 2000,
  /** Polling fallback for platforms without recursive fs.watch. */
  fsPollMs: 1000,
  /** How long one batch keeps retrying a retryable /rpc failure (bridge restarting, Studio busy). */
  retryBudgetMs: 30_000,
  retryBaseMs: 250,
  retryMaxMs: 5000,
  /** Cap on the program text + sources of one push `run`. */
  maxProgramBytes: 400 * 1024,
  /** A poll that takes longer than this stretches the poll interval (Studio's main thread is shared). */
  slowPollMs: 50,
};
