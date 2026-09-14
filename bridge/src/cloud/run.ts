import type { ZodError } from 'zod';
import { dispatch } from './actions.js';
import { CloudError } from './errors.js';
import { maskSecret, renderResult, scrubSecret } from './format.js';
import { createHttp } from './http.js';
import { describeKeySource, KEY_ENV, keyPaths, resolveKey, type KeySource } from './key.js';
import { cloudArgsSchema, type CloudArgs } from './schema.js';
import type { CloudContext, CloudLog, ToolText } from './types.js';

const CREATOR_HUB_KEYS = 'https://create.roblox.com/dashboard/credentials';

/**
 * Creator Hub permissions each action needs (API key → Access Permissions).
 * Scope names are the ones printed in the official reference for each operation.
 */
export function permissionsFor(a: { action: CloudArgs['action']; op?: string | undefined; what?: string | undefined }): string[] {
  const ds = (scope: string): string => `Data Stores → ${scope}`;
  switch (a.action) {
    case 'datastore':
      switch (a.op) {
        case 'list_stores':
          return [ds('universe-datastores.control:list')];
        case 'list_entries':
          return [ds('universe-datastores.objects:list')];
        case 'get':
          return [ds('universe-datastores.objects:read')];
        case 'set':
          return [ds('universe-datastores.objects:update'), ds('universe-datastores.objects:create (for keys that do not exist yet)')];
        case 'delete':
          return [ds('universe-datastores.objects:delete')];
        case 'increment':
          return [ds('universe-datastores.objects:create'), ds('universe-datastores.objects:update')];
        default:
          return [ds('universe-datastores.control:list'), ds('universe-datastores.objects:list / :read / :create / :update / :delete as needed')];
      }
    case 'ordered':
      return a.op === 'list' || a.op === 'get'
        ? ['Ordered Data Stores → universe.ordered-data-store.scope.entry:read']
        : ['Ordered Data Stores → universe.ordered-data-store.scope.entry:write'];
    case 'message':
      return ['Messaging Service → universe-messaging-service:publish'];
    case 'info':
      switch (a.what) {
        case 'key':
          // The probe needs no particular scope — reporting which ones are missing is its whole job.
          return ['none in particular — the probe reports which permissions this key has and which it lacks'];
        case 'group':
          return ['Groups → Read (group:read)'];
        case 'user':
          return ['Users → Read (user.advanced:read; user.social:read for social profiles)'];
        case 'me':
          return ['Groups → Read (group:read) for a group-owned place', 'Users → Read (user.advanced:read) for a user-owned place'];
        default:
          return ['the experience added to the key (Get Universe / Get Place list no extra scope in the reference)'];
      }
    case 'asset_upload':
      return ['Assets → Read + Write (asset:read, asset:write) for the creator that will own the asset'];
    case 'luau':
      return ['Luau Execution Sessions → Write (universe.place.luau-execution-session:write) for this experience'];
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
      if (/Only OAuth tokens and User API keys/i.test(detail)) {
        message += `. This endpoint only accepts a USER-owned API key (or OAuth); the configured key (from ${describeKeySource(source, ctx.home)}) is group-owned, which Roblox does not allow here. Everything universe-scoped (datastores, messaging, assets, luau) still works with it; create a user-owned key in Creator Hub for group/user lookups.`;
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
      const usesPlace = a.action === 'luau' || (a.action === 'info' && a.what === 'place');
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
    case 'rate_limited':
      message += '. Retried 3 times; wait before calling again.';
      break;
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
