import { badRequest } from './errors.js';
import type { HttpClient } from './http.js';
import { universeFrom } from './ids.js';
import type { CloudArgs } from './schema.js';
import { CLOUD_V2, asObject, need } from './shared.js';
import type { ActionOutcome, CloudContext } from './types.js';

/**
 * Experience notifications.
 * https://create.roblox.com/docs/cloud/reference/UserNotification
 *
 * POST /cloud/v2/users/{user_id}/notifications — note the path is keyed by the RECIPIENT, not by
 * the universe; the universe travels in the body as a resource path string. `message_id` is a
 * notification string created in Creator Hub (there is no Open Cloud API to make one), and its
 * {placeholders} are filled from `parameters`.
 */
/** payload.type has exactly two values and only this one is usable. */
const MOMENT = 'MOMENT';
/** joinExperience.launchData is capped at 200 bytes. */
const LAUNCH_DATA_MAX_BYTES = 200;

/** Open Cloud wants each parameter tagged; agents pass a plain map and the tagging happens here. */
export function parameterValues(parameters: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parameters)) {
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) throw badRequest(`parameter "${name}" is ${value}; notification parameters take an integer (int64Value) or a string (stringValue), not a fraction`);
      out[name] = { int64Value: value };
    } else if (typeof value === 'string') {
      out[name] = { stringValue: value };
    } else {
      throw badRequest(`parameter "${name}" must be a string or an integer (it fills a {placeholder} in the notification string)`);
    }
  }
  return out;
}

export async function notify(a: CloudArgs, ctx: CloudContext, http: HttpClient): Promise<ActionOutcome> {
  const userId = need(a.id, 'id', 'for notify (the user id to notify — they must have played this experience recently and allow notifications)');
  const messageId = need(a.message_id, 'message_id', 'for notify (a notification string id created in Creator Hub → Monetization/Engagement → Notifications; Open Cloud cannot create one)');
  const u = universeFrom(a, ctx);
  if (a.launch_data !== undefined && Buffer.byteLength(a.launch_data) > LAUNCH_DATA_MAX_BYTES) {
    throw badRequest(`launch_data is ${Buffer.byteLength(a.launch_data)} bytes; joinExperience.launchData allows at most ${LAUNCH_DATA_MAX_BYTES}`);
  }

  const payload: Record<string, unknown> = { type: MOMENT, messageId };
  if (a.parameters !== undefined) payload.parameters = parameterValues(a.parameters);
  if (a.launch_data !== undefined) payload.joinExperience = { launchData: a.launch_data };
  if (a.analytics_category !== undefined) payload.analyticsData = { category: a.analytics_category };

  // source.universe is a resource path string ("universes/123"), not the bare number.
  const res = await http.request({
    method: 'POST',
    path: `${CLOUD_V2}/users/${userId}/notifications`,
    json: { source: { universe: `universes/${u.universeId}` }, payload },
  });
  const body = asObject(res.body);
  return {
    value: {
      sent: true,
      user_id: userId,
      universe_id: u.universeId,
      ids_from: u.from,
      message_id: messageId,
      ...body,
      note: 'Delivery is not guaranteed: the recipient must have played this experience recently and have notifications enabled, and Open Cloud has no endpoint to check either. The response only confirms Roblox accepted the request.',
    },
  };
}
