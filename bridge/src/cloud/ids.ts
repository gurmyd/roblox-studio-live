import { CloudError } from './errors.js';
import type { CloudContext, CloudIds } from './types.js';

/**
 * Id defaulting: explicit arguments win, otherwise the ids of the connected Studio
 * session are used (universe = game.GameId, place = game.PlaceId, creator = the
 * place owner). Agents never have to ask the user for ids.
 */
export type IdsFrom = 'args' | 'studio' | 'mixed';

export interface UniverseRef {
  universeId: number;
  from: IdsFrom;
}

export interface PlaceRef extends UniverseRef {
  placeId: number;
}

export interface Creator {
  type: 'User' | 'Group';
  id: number;
}

const OPEN_STUDIO = 'Open the place in Roblox Studio with the Studio Live plugin connected';

function placeLabel(ids: CloudIds): string {
  return ids.placeName ? ` "${ids.placeName}"` : '';
}

function noIds(message: string): CloudError {
  return new CloudError('no_ids', message);
}

/**
 * `universeId` / `creatorType` / `creatorId` travel only in the hub's `hb` frames (docs/protocol.md
 * §2.7), not in the bootstrap `hello`, so right after Studio connects they are `undefined` for up
 * to one heartbeat interval. That is not the same as `0` (an unpublished place) and must not be
 * answered with "publish it" — an obedient agent might actually publish.
 */
const NOT_YET = 'the session has not reported it yet (it arrives with the next heartbeat, within ~10 s); retry in a few seconds';

export function universeFrom(args: { universe_id?: number | undefined }, ctx: CloudContext): UniverseRef {
  if (args.universe_id) return { universeId: args.universe_id, from: 'args' };
  const ids = ctx.ids();
  if (!ids) throw noIds(`universe_id not given and no Studio session is connected, so the open place's universe is unknown. ${OPEN_STUDIO}, or pass universe_id.`);
  if (ids.universeId === undefined) {
    throw noIds(`universe_id not given and the universe of the open place${placeLabel(ids)} is not known yet: ${NOT_YET}, or pass universe_id.`);
  }
  if (ids.universeId <= 0) {
    throw noIds(`universe_id not given and the open place${placeLabel(ids)} is not published (game.GameId is 0), so it has no universe. Publish it (File → Publish to Roblox) or pass universe_id.`);
  }
  return { universeId: ids.universeId, from: 'studio' };
}

export function placeFrom(args: { universe_id?: number | undefined; place_id?: number | undefined }, ctx: CloudContext): PlaceRef {
  const universe = universeFrom(args, ctx);
  if (args.place_id) return { universeId: universe.universeId, placeId: args.place_id, from: universe.from === 'args' ? 'args' : 'mixed' };
  const ids = ctx.ids();
  if (!ids) throw noIds(`place_id not given and no Studio session is connected. ${OPEN_STUDIO}, or pass place_id.`);
  if (ids.placeId === undefined) {
    throw noIds(`place_id not given and the PlaceId of the open place${placeLabel(ids)} is not known yet: ${NOT_YET}, or pass place_id.`);
  }
  if (ids.placeId <= 0) {
    throw noIds(`place_id not given and the open place${placeLabel(ids)} has no PlaceId yet (unpublished). Publish it or pass place_id.`);
  }
  return { universeId: universe.universeId, placeId: ids.placeId, from: universe.from === 'args' ? 'mixed' : 'studio' };
}

export function creatorFrom(explicit: Creator | undefined, ctx: CloudContext): Creator {
  if (explicit) return explicit;
  const ids = ctx.ids();
  if (!ids) throw noIds(`creator not given and no Studio session is connected. ${OPEN_STUDIO}, or pass creator {type: "User" | "Group", id}.`);
  if (ids.creatorType === undefined || ids.creatorId === undefined) {
    throw noIds(`creator not given and the owner of the open place${placeLabel(ids)} is not known yet: ${NOT_YET}, or pass creator {type: "User" | "Group", id}.`);
  }
  if (ids.creatorId <= 0) {
    throw noIds(`creator not given and the open place${placeLabel(ids)} reports no owner (game.CreatorId is 0: unpublished). Publish it or pass creator {type: "User" | "Group", id}.`);
  }
  return { type: ids.creatorType, id: ids.creatorId };
}

/** Id of a group or user: explicit `id`, else the place owner when it is of that type. */
export function ownerIdOfType(type: Creator['type'], explicit: number | undefined, ctx: CloudContext): number {
  if (explicit) return explicit;
  const ids = ctx.ids();
  if (!ids) throw noIds(`id not given and no Studio session is connected. ${OPEN_STUDIO}, or pass id.`);
  if (ids.creatorType === type && ids.creatorId) return ids.creatorId;
  const owner = ids.creatorType && ids.creatorId ? `a ${ids.creatorType.toLowerCase()} (${ids.creatorId})` : 'unknown';
  throw noIds(`id not given and the open place${placeLabel(ids)} is not owned by a ${type.toLowerCase()} (owner: ${owner}). Pass id, or use info what:"me" for the actual owner.`);
}
