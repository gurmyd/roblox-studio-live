import fsp from 'node:fs/promises';
import path from 'node:path';
import { CloudError, badRequest } from './errors.js';
import { REQUEST_TIMEOUT_MS, type HttpClient } from './http.js';
import { MAX_WAIT_MS, type CloudArgs } from './schema.js';
import { ASSETS_V1, DEFAULT_WAIT_MS, asObject, enc, need, pollUntilDone, stringField, uploadTimeoutMs } from './shared.js';
import type { ActionDeps, ActionOutcome } from './types.js';

/**
 * The asset lifecycle after creation: read it, put a new version behind the same id, list and
 * roll back versions, archive and restore.
 *
 * `asset_upload` mints a NEW id every time, so iterating on a mesh or a texture used to strew
 * dead asset ids behind it and break every reference already placed in the game. `asset update`
 * is the fix: same id, new content, one operation to poll.
 *
 * https://create.roblox.com/docs/cloud/reference/features/assets — all paths under /assets/v1.
 */
export const ASSET_OPS = ['get', 'update', 'versions', 'rollback', 'archive', 'restore'] as const;
/** List Asset Versions: 1..50, defaults to 8. */
const VERSIONS_PAGE_MAX = 50;

/** File formats accepted by the Assets API, by extension (shared with asset_upload). */
export const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.tga': 'image/tga',
  '.fbx': 'model/fbx',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.rbxm': 'model/x-rbxm',
  '.rbxmx': 'model/x-rbxm',
  '.mp4': 'video/mp4',
  '.mov': 'video/mov',
};

/**
 * Assets v1 documents `moderationState` as `Reviewing | Rejected | Approved`; real responses
 * have also shown `MODERATION_STATE_APPROVED`. Both fold to one lower-case word so an agent can
 * gate on a single spelling.
 */
export function normalizeModeration(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  return raw.replace(/^(MODERATION_STATE_|ASSET_TYPE_)/i, '').toLowerCase();
}

/** An Operation's `path` is "operations/{id}" — the poll URL must not repeat the prefix. */
export function operationIdOf(op: Record<string, unknown>): string | undefined {
  const explicit = stringField(op, 'operationId');
  if (explicit) return explicit;
  const p = stringField(op, 'path');
  if (!p) return undefined;
  const last = p.split('/').pop();
  return last && last !== '' ? last : undefined;
}

function assetIdOf(a: CloudArgs): number {
  return need(a.asset_id, 'asset_id', 'for asset ops (the numeric id returned by asset_upload)');
}

async function readFile(file: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (!path.isAbsolute(file)) throw badRequest(`file must be an absolute path (got "${file}")`);
  const ext = path.extname(file).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) throw badRequest(`unsupported file extension "${ext}"; supported: ${Object.keys(CONTENT_TYPES).join(' ')}`);
  try {
    return { bytes: await fsp.readFile(file), contentType };
  } catch (err) {
    throw badRequest(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Polls /assets/v1/operations/{id} until the operation finishes or the deadline passes. */
async function awaitOperation(
  op: Record<string, unknown>,
  http: HttpClient,
  deps: ActionDeps,
  started: number,
  deadline: number,
): Promise<{ done: Record<string, unknown>; operationId: string; timedOut: boolean }> {
  const operationId = operationIdOf(op);
  if (!operationId) throw new CloudError('upload_failed', 'Open Cloud accepted the change but returned no operation id to poll', { details: { response: op } });
  const { state, timedOut } = await pollUntilDone({
    deps,
    deadline,
    first: op,
    done: (s) => s.done === true,
    fetch: async () => asObject((await http.request({ method: 'GET', path: `${ASSETS_V1}/operations/${enc(operationId)}`, idempotent: true })).body),
  });
  void started;
  return { done: state, operationId, timedOut };
}

function assetSummary(asset: Record<string, unknown>): Record<string, unknown> {
  const rawId = asset.assetId;
  const assetId = typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : rawId;
  const moderationRaw = asObject(asset.moderationResult).moderationState;
  return {
    ...(assetId !== undefined && assetId !== null ? { asset_id: assetId, use: `rbxassetid://${assetId}` } : {}),
    ...(asset.assetType !== undefined ? { asset_type: asset.assetType } : {}),
    ...(asset.displayName !== undefined ? { display_name: asset.displayName } : {}),
    ...(asset.revisionId !== undefined ? { revision_id: asset.revisionId } : {}),
    ...(typeof moderationRaw === 'string' ? { moderation: normalizeModeration(moderationRaw), moderation_raw: moderationRaw } : {}),
  };
}

export async function asset(a: CloudArgs, http: HttpClient, deps: ActionDeps): Promise<ActionOutcome> {
  const op = need(a.op, 'op', `for asset: ${ASSET_OPS.join(' | ')}`);
  const started = deps.now();

  switch (op) {
    case 'get': {
      const id = assetIdOf(a);
      // GET /assets/v1/assets/{assetId}?readMask=… (comma-separated extra metadata fields)
      const res = await http.request({ method: 'GET', path: `${ASSETS_V1}/assets/${id}`, query: { readMask: a.read_mask }, idempotent: true });
      const body = asObject(res.body);
      return { value: { asset_id: id, ...assetSummary(body), ...body } };
    }

    case 'update': {
      const id = assetIdOf(a);
      // PATCH /assets/v1/assets/{assetId}  multipart: request (JSON Asset) + optional fileContent.
      // With a file it is long-running (poll the Operation); metadata-only returns the fields inline.
      const request: Record<string, unknown> = { assetId: id };
      if (a.name !== undefined) request.displayName = a.name;
      if (a.description !== undefined) request.description = a.description;
      const form = new FormData();
      let upload: Record<string, unknown> = {};
      let timeoutMs = a.timeout_ms ?? DEFAULT_WAIT_MS;
      if (a.file !== undefined) {
        const { bytes, contentType } = await readFile(a.file);
        form.append('fileContent', new Blob([bytes], { type: contentType }), path.basename(a.file));
        timeoutMs = uploadTimeoutMs(bytes.length, a.timeout_ms ?? DEFAULT_WAIT_MS, REQUEST_TIMEOUT_MS, MAX_WAIT_MS);
        upload = { file: a.file, bytes: bytes.length, content_type: contentType };
      } else if (a.name === undefined && a.description === undefined) {
        throw badRequest('asset update needs something to change: pass file (new content behind the same asset id) and/or name / description');
      }
      form.append('request', JSON.stringify(request));
      // updateMask names the metadata fields being changed; content updates carry no mask.
      const mask = [a.name !== undefined ? 'displayName' : '', a.description !== undefined ? 'description' : ''].filter((f) => f !== '').join(',');
      const res = await http.request({
        method: 'PATCH',
        path: `${ASSETS_V1}/assets/${id}`,
        ...(mask !== '' ? { query: { updateMask: mask } } : {}),
        form,
        timeoutMs,
      });
      const body = asObject(res.body);

      // Metadata-only updates answer with the changed fields, not an Operation.
      if (body.done === undefined && body.path === undefined && body.operationId === undefined) {
        return { value: { asset_id: id, updated: true, ...upload, ...body, elapsed_ms: deps.now() - started } };
      }
      const deadline = started + timeoutMs;
      const { done, operationId, timedOut } = await awaitOperation(body, http, deps, started, deadline);
      if (timedOut) {
        return {
          value: {
            asset_id: id,
            ...upload,
            pending: true,
            operation_id: operationId,
            elapsed_ms: deps.now() - started,
            note: `Update accepted but not finished in time. Call cloud {action:"asset_upload", operation_id:"${operationId}"} to keep waiting.`,
          },
        };
      }
      if (done.error !== undefined && done.error !== null) {
        const reason = stringField(asObject(done.error), 'message') ?? JSON.stringify(done.error);
        return {
          isError: true,
          value: { error: { code: 'upload_failed', message: `Asset update failed: ${reason}`, operation_error: done.error, operation_id: operationId, asset_id: id, ...upload } },
        };
      }
      const updated = asObject(done.response);
      return {
        value: {
          asset_id: id,
          updated: true,
          ...assetSummary(updated),
          ...upload,
          operation_id: operationId,
          elapsed_ms: deps.now() - started,
          note: 'Same asset id, new version — every rbxassetid:// reference already placed in the game now resolves to this content once moderation approves it.',
        },
      };
    }

    case 'versions': {
      const id = assetIdOf(a);
      if (a.page_size !== undefined && a.page_size > VERSIONS_PAGE_MAX) throw badRequest(`page_size is ${a.page_size}; List Asset Versions allows at most ${VERSIONS_PAGE_MAX}`);
      // GET /assets/v1/assets/{assetId}/versions?maxPageSize&pageToken (defaults to 8 per page)
      const res = await http.request({ method: 'GET', path: `${ASSETS_V1}/assets/${id}/versions`, query: { maxPageSize: a.page_size, pageToken: a.page_token }, idempotent: true });
      return { value: { asset_id: id, ...asObject(res.body) } };
    }

    case 'rollback': {
      const id = assetIdOf(a);
      const version = need(a.version, 'version', 'for asset rollback (the version number to restore, from asset versions)');
      const assetVersion = `assets/${id}/versions/${version}`;
      // POST /assets/v1/assets/{assetId}/versions:rollback
      // The spec declares multipart with an `assetVersion` field while its own runnable sample
      // sends JSON. The field name is certain, the encoding is not — so try JSON (the sample) and
      // fall back to multipart on a 400 rather than making the caller guess.
      let res;
      try {
        res = await http.request({ method: 'POST', path: `${ASSETS_V1}/assets/${id}/versions:rollback`, json: { assetVersion } });
      } catch (err) {
        if (!(err instanceof CloudError) || err.status !== 400) throw err;
        const form = new FormData();
        form.append('assetVersion', assetVersion);
        res = await http.request({ method: 'POST', path: `${ASSETS_V1}/assets/${id}/versions:rollback`, form });
      }
      return { value: { asset_id: id, rolled_back_to: version, asset_version: assetVersion, ...asObject(res.body) } };
    }

    case 'archive':
    case 'restore': {
      const id = assetIdOf(a);
      // POST /assets/v1/assets/{assetId}:archive | :restore — no request body.
      const res = await http.request({ method: 'POST', path: `${ASSETS_V1}/assets/${id}:${op}`, json: {} });
      return {
        value: {
          asset_id: id,
          [op === 'archive' ? 'archived' : 'restored']: true,
          ...asObject(res.body),
          note: op === 'archive' ? 'Archived assets stop resolving in experiences; restore puts it back. There is no delete in Open Cloud.' : 'Restored; the asset resolves again.',
        },
      };
    }

    default:
      throw badRequest(`op "${op}" is not an asset op (use ${ASSET_OPS.join(' | ')})`);
  }
}
