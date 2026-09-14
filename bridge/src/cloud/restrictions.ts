import { badRequest } from './errors.js';
import type { HttpClient } from './http.js';
import { placeFrom, universeFrom } from './ids.js';
import type { CloudArgs } from './schema.js';
import { CLOUD_V2, asObject, need } from './shared.js';
import type { ActionOutcome, CloudContext } from './types.js';

/**
 * User restrictions — banning and unbanning players.
 * https://create.roblox.com/docs/cloud/reference/UserRestriction
 *
 * Three things the API does not make obvious, all handled here:
 *   - the restriction id IS the user id, so there is nothing extra to look up;
 *   - there is no POST and no DELETE. A ban is PATCH with active:true (it upserts) and an unban
 *     is the same PATCH with active:false;
 *   - gameJoinRestriction is replaced atomically, so a field left out is not "kept", it is
 *     cleared. `ban` therefore always sends the complete object.
 */
export const RESTRICTION_OPS = ['list', 'get', 'ban', 'unban', 'logs'] as const;
export const RESTRICTION_LEVELS = ['universe', 'place'] as const;
/** List/logs: default 10, max 100. */
const PAGE_MAX = 100;

export async function restriction(a: CloudArgs, ctx: CloudContext, http: HttpClient): Promise<ActionOutcome> {
  const op = need(a.op, 'op', `for restriction: ${RESTRICTION_OPS.join(' | ')}`);
  const level = a.level ?? 'universe';
  if (a.page_size !== undefined && a.page_size > PAGE_MAX) throw badRequest(`page_size is ${a.page_size}; user restriction listings allow at most ${PAGE_MAX}`);

  // A place-level ban keeps the player out of one place; the universe-level one keeps them out
  // of the whole experience. `level` picks it explicitly — never the presence of place_id, which
  // defaults from the open Studio session and would silently narrow every ban.
  const base = ((): { path: string; context: Record<string, unknown> } => {
    if (level === 'place') {
      const p = placeFrom(a, ctx);
      return { path: `${CLOUD_V2}/universes/${p.universeId}/places/${p.placeId}/user-restrictions`, context: { universe_id: p.universeId, place_id: p.placeId, ids_from: p.from, level } };
    }
    const u = universeFrom(a, ctx);
    return { path: `${CLOUD_V2}/universes/${u.universeId}/user-restrictions`, context: { universe_id: u.universeId, ids_from: u.from, level } };
  })();

  switch (op) {
    case 'list': {
      // GET …/user-restrictions?maxPageSize&pageToken  (no filter on this operation)
      const res = await http.request({ method: 'GET', path: base.path, query: { maxPageSize: a.page_size, pageToken: a.page_token }, idempotent: true });
      return { value: { ...base.context, ...asObject(res.body) } };
    }
    case 'get': {
      const id = need(a.id, 'id', 'for restriction get (the player’s user id — it doubles as the restriction id)');
      const res = await http.request({ method: 'GET', path: `${base.path}/${id}`, idempotent: true });
      return { value: { ...base.context, user_id: id, ...asObject(res.body) } };
    }
    case 'ban': {
      const id = need(a.id, 'id', 'for restriction ban (the player’s user id)');
      const displayReason = need(a.display_reason, 'display_reason', 'for restriction ban (shown to the banned player)');
      const privateReason = need(a.reason, 'reason', 'for restriction ban (the private moderation note; use display_reason for what the player sees)');
      if (a.duration_s !== undefined && (!Number.isFinite(a.duration_s) || a.duration_s <= 0)) {
        throw badRequest('duration_s must be a positive number of seconds; omit it entirely for a permanent ban (-1 is not how Open Cloud expresses that)');
      }
      // PATCH …/user-restrictions/{userId} — upsert. `duration` is a protobuf duration string;
      // leaving it out is what makes a ban permanent. No updateMask: masks that index into
      // gameJoinRestriction are rejected, and the whole object is replaced regardless.
      const gameJoinRestriction = {
        active: true,
        ...(a.duration_s !== undefined ? { duration: `${Math.ceil(a.duration_s)}s` } : {}),
        privateReason,
        displayReason,
        ...(a.exclude_alts !== undefined ? { excludeAltAccounts: a.exclude_alts } : {}),
      };
      const res = await http.request({ method: 'PATCH', path: `${base.path}/${id}`, json: { gameJoinRestriction }, idempotent: true });
      return {
        value: {
          ...base.context,
          user_id: id,
          banned: true,
          permanent: a.duration_s === undefined,
          ...(a.duration_s !== undefined ? { duration_s: Math.ceil(a.duration_s) } : {}),
          ...asObject(res.body),
          note:
            level === 'place'
              ? 'Banned from this place only; other places in the experience still admit them. Use level "universe" to ban from the whole experience.'
              : 'Banned from every place in the experience.',
        },
      };
    }
    case 'unban': {
      const id = need(a.id, 'id', 'for restriction unban (the player’s user id)');
      // The same PATCH with active:false. Reasons and duration are cleared with it, which is
      // what lifting a ban should do.
      const res = await http.request({ method: 'PATCH', path: `${base.path}/${id}`, json: { gameJoinRestriction: { active: false } }, idempotent: true });
      return { value: { ...base.context, user_id: id, banned: false, ...asObject(res.body) } };
    }
    case 'logs': {
      if (level === 'place') throw badRequest('restriction logs are universe-level only; drop level:"place" (there is no per-place log endpoint)');
      const u = universeFrom(a, ctx);
      // GET …/user-restrictions:listLogs?maxPageSize&pageToken&filter
      // filter is a small CEL subset over `user` and `place`, e.g. user == "users/156".
      const res = await http.request({
        method: 'GET',
        path: `${CLOUD_V2}/universes/${u.universeId}/user-restrictions:listLogs`,
        query: { maxPageSize: a.page_size, pageToken: a.page_token, filter: a.filter },
        idempotent: true,
      });
      return {
        value: {
          universe_id: u.universeId,
          ids_from: u.from,
          ...asObject(res.body),
          note: 'Log entries carry active / duration / privateReason at the TOP level, unlike a restriction where they sit under gameJoinRestriction. A moderator of {} (gameServerScript) means a Luau script issued it, not a person.',
        },
      };
    }
    default:
      throw badRequest(`op "${op}" is not a restriction op (use ${RESTRICTION_OPS.join(' | ')})`);
  }
}
