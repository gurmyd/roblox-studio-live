import fsp from 'node:fs/promises';
import path from 'node:path';
import { badRequest } from './errors.js';
import { REQUEST_TIMEOUT_MS, type HttpClient } from './http.js';
import { placeFrom } from './ids.js';
import { MAX_WAIT_MS, type CloudArgs } from './schema.js';
import { DEFAULT_WAIT_MS, asObject, need, uploadTimeoutMs } from './shared.js';
import type { ActionOutcome, CloudContext } from './types.js';

/**
 * Place publishing — the one Open Cloud operation that closes the loop between the place open
 * in Studio and everything that reads the *published* place (`luau`, `instance`).
 *
 * https://create.roblox.com/docs/cloud/guides/usage-publishing
 * POST /universes/v1/{universeId}/places/{placeId}/versions?versionType=Published|Saved
 * The file bytes are the raw request body (not multipart, not base64); the Content-Type header
 * selects the format. 200 carries {"versionNumber": N} — served as text/plain, so it arrives as
 * a string from some clients. There is no /cloud/v2 equivalent and no long-running operation:
 * the call is synchronous.
 */
const PUBLISH_V1 = '/universes/v1';
export const VERSION_TYPES = ['Published', 'Saved'] as const;

/** Content types the endpoint accepts, by place-file format. Sending the wrong one is a 400. */
const BINARY_CONTENT_TYPE = 'application/octet-stream';
const XML_CONTENT_TYPE = 'application/xml';

/**
 * The OpenAPI spec declares x-roblox-size-limit 10485760 (10 MiB) on this operation, while the
 * general publishing docs describe a 100 MB place-file ceiling. The two cannot both be right, so
 * the tool refuses only what is certainly too big and warns in the band between them rather than
 * blocking a publish that may well succeed.
 */
export const SPEC_SIZE_LIMIT = 10 * 1024 * 1024;
export const HARD_SIZE_LIMIT = 100 * 1024 * 1024;

/**
 * Instance types the publish API silently does NOT update, verbatim from the guide: "If your game
 * contains EditableImage, EditableMesh, PartOperation, SurfaceAppearance, or BaseWrap instances,
 * publish from Studio after modifying them." PartOperation covers every union and negation, so
 * this is a quiet-corruption trap for exactly the kind of place an agent builds — the result says
 * so on every publish rather than leaving it to be discovered in-game.
 */
export const NOT_PUBLISHED_BY_API = ['EditableImage', 'EditableMesh', 'PartOperation (unions and negations)', 'SurfaceAppearance', 'BaseWrap'];

export interface PlaceFormat {
  contentType: string;
  format: 'binary' | 'xml';
  /** Set when the bytes disagree with the extension; the bytes win. */
  mismatch?: string;
}

/**
 * Picks the Content-Type from the file's own bytes rather than trusting the extension: both
 * formats start with the ASCII "<roblox" prefix, so a naive check misreads binary as XML and
 * earns a 400 "Invalid file content". A binary .rbxl continues "<roblox!" + 89 FF 0D 0A 1A 0A;
 * the XML form continues "<roblox " (or the file opens with an <?xml declaration).
 */
export function detectPlaceFormat(file: string, bytes: Buffer): PlaceFormat {
  const head = bytes.subarray(0, 8).toString('binary');
  const ext = path.extname(file).toLowerCase();
  const byExtension = ext === '.rbxlx' ? 'xml' : ext === '.rbxl' ? 'binary' : undefined;
  const byContent = head.startsWith('<roblox!') ? 'binary' : head.startsWith('<roblox ') || head.startsWith('<?xml') ? 'xml' : undefined;
  // The bytes are authoritative: a file that matches neither signature is not a place, whatever
  // it is named, and uploading it would only earn a 400 after a wasted upload.
  const format = byContent;
  if (!format) {
    throw badRequest(
      `${file} does not look like a Roblox place file: it starts with ${JSON.stringify(head.slice(0, 8))}, but a place file starts with "<roblox!" (binary .rbxl) or "<roblox " / "<?xml" (.rbxlx). Save the place with File → Save to File in Studio.`,
    );
  }
  const contentType = format === 'xml' ? XML_CONTENT_TYPE : BINARY_CONTENT_TYPE;
  const mismatch =
    byContent && byExtension && byContent !== byExtension
      ? `the file is named ${ext} but its contents are ${byContent}; sent as ${contentType} to match the contents (the extension would have earned a 400)`
      : undefined;
  return { contentType, format, ...(mismatch ? { mismatch } : {}) };
}

/** The response is documented as text/plain carrying JSON, so it can arrive already parsed or as a string. */
export function versionNumberOf(body: unknown): number | null {
  const record = typeof body === 'string' ? tryParse(body) : body;
  const value = asObject(record).versionNumber;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function publish(a: CloudArgs, ctx: CloudContext, http: HttpClient): Promise<ActionOutcome> {
  const file = need(a.file, 'file', 'for publish (absolute path to a .rbxl or .rbxlx place file saved from Studio)');
  if (!path.isAbsolute(file)) throw badRequest(`file must be an absolute path (got "${file}")`);
  const versionType = a.version_type ?? 'Published';

  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(file);
  } catch (err) {
    throw badRequest(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}. Save the place in Studio first (File → Save to File).`);
  }
  if (bytes.length === 0) throw badRequest(`${file} is empty`);
  if (bytes.length > HARD_SIZE_LIMIT) {
    throw badRequest(`${file} is ${Math.round(bytes.length / (1024 * 1024))} MB; Roblox place files cap at 100 MB, so this cannot be published. Reduce the place or publish from Studio.`);
  }
  const format = detectPlaceFormat(file, bytes);
  const p = placeFrom(a, ctx);
  const timeoutMs = uploadTimeoutMs(bytes.length, a.timeout_ms ?? DEFAULT_WAIT_MS, REQUEST_TIMEOUT_MS, MAX_WAIT_MS);

  // POST /universes/v1/{universeId}/places/{placeId}/versions?versionType=…
  // Never retried: each accepted call creates a new place version, so replaying a 5xx that the
  // server may already have applied would publish twice.
  const res = await http.request({
    method: 'POST',
    path: `${PUBLISH_V1}/${p.universeId}/places/${p.placeId}/versions`,
    query: { versionType },
    raw: { bytes, contentType: format.contentType },
    timeoutMs,
  });

  const versionNumber = versionNumberOf(res.body);
  const warnings: string[] = [];
  if (format.mismatch) warnings.push(format.mismatch);
  if (bytes.length > SPEC_SIZE_LIMIT) {
    warnings.push(`the file is ${Math.round(bytes.length / (1024 * 1024))} MB and the publish API documents a 10 MiB request limit (the general place-file limit is 100 MB); if this call 400s, that is why`);
  }
  return {
    value: {
      universe_id: p.universeId,
      place_id: p.placeId,
      ids_from: p.from,
      published: versionType === 'Published',
      version_type: versionType,
      version_number: versionNumber,
      file,
      bytes: bytes.length,
      format: format.format,
      content_type: format.contentType,
      upload_timeout_ms: timeoutMs,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(versionNumber === null ? { note_version: 'Open Cloud accepted the upload but returned no versionNumber; the raw response is in response.', response: res.body } : {}),
      not_updated_by_this_api: NOT_PUBLISHED_BY_API,
      note:
        versionType === 'Published'
          ? `Place ${p.placeId} is now live at version ${versionNumber ?? '(unknown)'}. cloud luau and cloud instance read this published copy, so they see these changes from now on. The instance types in not_updated_by_this_api are NOT carried by this API — if the place uses them, publish from Studio instead.`
          : `Saved as version ${versionNumber ?? '(unknown)'} WITHOUT publishing (version_type "Saved"), so live servers and cloud luau still run the previous version. Re-run with version_type "Published" to go live.`,
    },
  };
}
