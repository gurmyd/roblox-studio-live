/**
 * Public types of the Open Cloud module. The bridge supplies a `CloudContext`:
 * the ids of the connected Studio session, a logger, and the STUDIO_LIVE_HOME dir
 * that holds the API key file.
 */
export interface CloudIds {
  /** game.GameId of the open place (0 / undefined when unpublished). */
  universeId?: number;
  /** game.PlaceId of the open place. */
  placeId?: number;
  creatorType?: 'User' | 'Group';
  creatorId?: number;
  placeName?: string;
}

export type CloudLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface CloudContext {
  /** Ids of the active Studio session, or null when no hub is connected. */
  ids(): CloudIds | null;
  log(level: CloudLogLevel, msg: string, data?: Record<string, unknown>): void;
  /** STUDIO_LIVE_HOME directory (holds opencloud.json / opencloud.key). */
  home: string;
}

export interface ToolText {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export type CloudLog = (level: CloudLogLevel, msg: string, data?: Record<string, unknown>) => void;
