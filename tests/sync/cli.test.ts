import { describe, expect, it } from 'vitest';
import { SYNC_USAGE, parseSyncArgs } from '../../bridge/src/sync/cli.js';

describe('parseSyncArgs', () => {
  it('parses the documented flags with the port from STUDIO_LIVE_PORT by default', () => {
    expect(parseSyncArgs(['C:/proj'], {})).toEqual({ dir: 'C:/proj', port: 47800, pull: false, once: false, hotpatch: true });
    expect(parseSyncArgs(['--pull', 'src', '--once', '--no-hotpatch'], { STUDIO_LIVE_PORT: '47801' })).toEqual({ dir: 'src', port: 47801, pull: true, once: true, hotpatch: false });
    expect(parseSyncArgs(['src', '--port', '5000'], { STUDIO_LIVE_PORT: '47801' }).port).toBe(5000);
    expect(parseSyncArgs(['src', '--port=5001'], {}).port).toBe(5001);
  });

  it('rejects missing or extra arguments, unknown options and bad ports', () => {
    expect(() => parseSyncArgs([], {})).toThrow(/missing <dir>/);
    expect(() => parseSyncArgs(['a', 'b'], {})).toThrow(/unexpected argument b/);
    expect(() => parseSyncArgs(['a', '--watch'], {})).toThrow(/unknown option --watch/);
    expect(() => parseSyncArgs(['a', '--port'], {})).toThrow(/--port needs a value/);
    expect(() => parseSyncArgs(['a', '--port', 'x'], {})).toThrow(/invalid port/);
    expect(() => parseSyncArgs(['a'], { STUDIO_LIVE_PORT: '99999' })).toThrow(/invalid port/);
    expect(SYNC_USAGE).toMatch(/--pull/);
  });
});
