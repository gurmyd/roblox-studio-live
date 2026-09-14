import type { ZodError } from 'zod';
import { dispatch } from './actions.js';
import { permissionsOf } from './capabilities.js';
import { CloudError } from './errors.js';
import { maskSecret, renderResult, scrubSecret } from './format.js';
import { createHttp } from './http.js';
import { describeKeySource, KEY_ENV, keyPaths, resolveKey, type KeySource } from './key.js';
import { cloudArgsSchema, type CloudArgs } from './schema.js';
import type { CloudContext, CloudLog, ToolText } from './types.js';

const CREATOR_HUB_KEYS = 'https://create.roblox.com/dashboard/credentials';

/**
 * Creator Hub permissions each call needs (API key → Access Permissions), resolved through the
 * one capability table in capabilities.ts. The `info what:"key"` probe reads the same table, so
 * the permission a 403 tells you to add is always the one the probe measured.
 */
export function permissionsFor(a: { action: CloudArgs['action']; op?: string | undefined; what?: string | undefined }): string[] {
  switch (a.action) {
    case 'datastore':
      switch (a.op) {
        case 'list_stores':
          return permissionsOf('datastore.list');
        case 'list_entries':
          return permissionsOf('datastore.listEntries');
        case 'get':
          return permissionsOf('datastore.read');
        case 'set':
          return permissionsOf('datastore.set');
        case 'delete':
          return permissionsOf('datastore.delete');
        case 'increment':
          return permissionsOf('datastore.increment');
        default:
          return ['Data Stores → universe-datastores.control:list', 'Data Stores → universe-datastores.objects:list / :read / :create / :update / :delete as needed'];
      }
    case 'ordered':
      return permissionsOf(a.op === 'list' || a.op === 'get' ? 'ordered.read' : 'ordered.write');
    case 'memory':
      switch (a.op) {
        case 'map_list':
        case 'map_get':
          return permissionsOf('memory.mapRead');
        case 'map_set':
        case 'map_delete':
          return permissionsOf('memory.mapWrite');
        case 'queue_read':
          return permissionsOf('memory.queueRead');
        default:
          return permissionsOf('memory.queueWrite');
      }
    case 'message':
      return permissionsOf('message.publish');
    case 'info':
      switch (a.what) {
        case 'key':
          // The probe needs no particular scope — reporting which ones are missing is its whole job.
          return ['none in particular — the probe reports which permissions this key has and which it lacks'];
        case 'group':
          return permissionsOf('info.group');
        case 'user':
          return permissionsOf('info.user');
        case 'me':
          return ['Groups → Read (group:read) for a group-owned place', 'Users → Read (user.advanced:read) for a user-owned place'];
        case 'memberships':
        case 'roles':
          return permissionsOf('group.read');
        case 'inventory':
          return permissionsOf('inventory.read');
        case 'subscription':
          return permissionsOf('subscription.read');
        default:
          return ['the experience added to the key (Get Universe / Get Place list no extra scope in the reference)'];
      }
    case 'publish':
      return permissionsOf('place.publish');
    case 'asset_upload':
      return permissionsOf('asset.upload');
    case 'asset':
      return permissionsOf(a.op === 'get' || a.op === 'versions' ? 'asset.read' : 'asset.upload');
    case 'luau':
      return permissionsOf('luau.execute');
    case 'instance':
      return permissionsOf(a.op === 'update' ? 'instance.write' : 'instance.read');
    case 'restriction':
      return permissionsOf(a.op === 'ban' || a.op === 'unban' ? 'restriction.write' : 'restriction.read');
    case 'notify':
      return permissionsOf('notify.send');
    default:
      return [];
  }
}

function formatIssues(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function missingKeyMessage(home: string, problems: string[], permissions: string[]): string {
  const { json, file } = keyPaths(home);
  const lines = [
    'No Roblox Open Cloud API key is configured. Put one in ONE of these places (read again on every call, so no restart is needed):',
    `  1. env ${KEY_ENV}=<key>`,
    `  2. ${json}  containing {"key":"<key>"}`,
    `  3. ${file}  containing just the key`,
    `Create the key at ${CREATOR_HUB_KEYS} (Open Cloud → API Keys), add this experience under Access Permissions, and for this call enable: ${permissions.join('; ')}.`,
  ];
  if (problems.length > 0) lines.push(`Problems found: ${problems.join(' | ')}`);
  return lines.join('\n');
}

function describeError(err: CloudError, a: CloudArgs, ctx: CloudContext, permissions: string[], source: KeySource): Record<string, unknown> {
  let message = err.message;
  const extra: Record<string, unknown> = {};
  switch (err.code) {
    case 'unauthorized': {
      // Roblox answers 401 "Only OAuth tokens and User API keys are supported" on the Groups/Users
      // endpoints when the key is group-owned (measured live) — that is a key *type* limit, not a bad key.
      const detail = JSON.stringify(err.details ?? {});
      // Roblox words it two ways: "Only OAuth tokens and User API keys are supported" on Groups/Users
      // reads, "Authentication type provided was invalid!" on inventory (both measured live).
      if (/Only OAuth tokens and User API keys|Authentication type provided was invalid/i.test(detail)) {
        message += `. This endpoint only accepts a USER-owned API key (or OAuth); the configured key (from ${describeKeySource(source, ctx.home)}) is group-owned, which Roblox does not allow here. Everything universe-scoped (datastores, messaging, assets, luau) still works with it; create a user-owned key in Creator Hub for group / user / membership / role / inventory reads.`;
        extra.key_type_limit = true;
      } else {
        message += `. The key (from ${describeKeySource(source, ctx.home)}) was rejected: it may be mistyped, expired, revoked, or limited to other IPs. Replace it in place — the key is re-read on every call.`;
      }
      break;
    }
    case 'forbidden': {
      const universe = a.universe_id ?? ctx.ids()?.universeId;
      message += `. In Creator Hub (${CREATOR_HUB_KEYS} → your key → Access Permissions) add${universe ? ` universe ${universe}` : ' this experience'} and enable: ${permissions.join('; ')}. Also check the key's IP allow-list and expiry.`;
      extra.permissions = permissions;
      break;
    }
    case 'not_found': {
      const ids = ctx.ids();
      const usesPlace = a.action === 'luau' || a.action === 'publish' || a.action === 'instance' || (a.action === 'restriction' && a.level === 'place') || (a.action === 'info' && a.what === 'place');
      extra.looked_up = {
        ...(a.universe_id ?? ids?.universeId ? { universe_id: a.universe_id ?? ids?.universeId } : {}),
        ...(usesPlace && (a.place_id ?? ids?.placeId) ? { place_id: a.place_id ?? ids?.placeId } : {}),
        ...(a.store ? { store: a.store } : {}),
        ...(a.scope ? { scope: a.scope } : {}),
        ...(a.key ? { key: a.key } : {}),
        ...(a.id ? { id: a.id } : {}),
      };
      message += '. Check the ids/names in looked_up; a data store key that was never written also answers 404.';
      break;
    }
    case 'conflict': {
      if (a.action === 'publish') {
        // The spec documents 409 only as "place not part of the universe", but the common cause
        // is a busy place — an active Team Create session, or the place open in Studio, which is
        // exactly the situation this tool runs in.
        message +=
          '. For publish a 409 usually means the place is busy rather than mismatched: an active Team Create session, or the place being open in Studio, blocks the upload. Close or stop editing it and retry in a minute. It can also mean place_id really does not belong to universe_id — check both against cloud info place.';
        extra.likely_cause = 'the place is open in Studio or in an active Team Create session';
      }
      break;
    }
    case 'rate_limited': {
      const attempts = typeof err.details.attempts === 'number' ? err.details.attempts : 1;
      message += attempts > 1 ? `. Retried ${attempts - 1} times; wait before calling again.` : '. Not retried; wait before calling again.';
      if (a.action === 'restriction') {
        message += ' Roblox also limits how often one user’s restriction can change, and a heavily used id (1, measured live) can be throttled on the very first call; wait a minute or use another account.';
      }
      break;
    }
    case 'bad_request': {
      if (a.action === 'notify' && /not opted in/i.test(message)) {
        message += '. The player has to opt in from inside the experience (ExperienceNotificationService:PromptOptIn); Open Cloud cannot opt them in.';
        extra.not_opted_in = true;
      }
      break;
    }
    case 'server_error':
      message +=
        err.details.attempts === 1 && err.details.not_retried !== undefined
          ? '. Not retried: this call is not idempotent and the server may already have applied it — check (e.g. datastore get) before repeating it.'
          : '. Retried 3 times; Open Cloud may be degraded, try again later.';
      break;
    default:
      break;
  }
  return { error: { code: err.code, message, ...(err.status !== undefined ? { status: err.status } : {}), ...extra, ...err.details } };
}

function finish(value: unknown, key: string | null, isError: boolean): ToolText {
  const { text } = renderResult(value);
  const masked = maskSecret(text, key);
  return isError ? { content: [{ type: 'text', text: masked }], isError: true } : { content: [{ type: 'text', text: masked }] };
}

const realDeps = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  now: (): number => Date.now(),
};

export async function runCloudTool(args: unknown, ctx: CloudContext): Promise<ToolText> {
  const parsed = cloudArgsSchema.safeParse(args);
  if (!parsed.success) return finish({ error: { code: 'bad_request', message: `invalid arguments: ${formatIssues(parsed.error)}` } }, null, true);
  const a = parsed.data;
  const permissions = permissionsFor(a);

  const resolved = await resolveKey(ctx.home);
  if (!resolved.ok) {
    ctx.log('warn', 'cloud call without an API key', { action: a.action, problems: resolved.problems });
    return finish({ error: { code: 'no_api_key', message: missingKeyMessage(ctx.home, resolved.problems, permissions), permissions } }, null, true);
  }
  const key = resolved.key;
  const log: CloudLog = (level, msg, data) => ctx.log(level, maskSecret(msg, key), data ? (scrubSecret(data, key) as Record<string, unknown>) : undefined);
  const http = createHttp({ key, log });

  try {
    const outcome = await dispatch(a, ctx, http, { ...realDeps, keySource: describeKeySource(resolved.source, ctx.home) });
    return finish(outcome.value, key, outcome.isError === true);
  } catch (err) {
    if (err instanceof CloudError) {
      log('info', 'cloud call failed', { action: a.action, op: a.op, code: err.code, status: err.status });
      return finish(describeError(err, a, ctx, permissions, resolved.source), key, true);
    }
    const reason = err instanceof Error ? err.message : String(err);
    log('error', 'cloud call crashed', { action: a.action, error: reason });
    return finish({ error: { code: 'internal', message: reason } }, key, true);
  }
}
