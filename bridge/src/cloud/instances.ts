import { badRequest } from './errors.js';
import type { HttpClient } from './http.js';
import { placeFrom } from './ids.js';
import type { CloudArgs } from './schema.js';
import { CLOUD_V2, DEFAULT_WAIT_MS, asObject, enc, need, pollUntilDone, stringField } from './shared.js';
import type { ActionDeps, ActionOutcome, CloudContext } from './types.js';

/**
 * The Instance API — reading and editing instances of the PUBLISHED place without opening it.
 * https://create.roblox.com/docs/cloud/reference/Instance
 *
 * Two properties of this API shape the whole module:
 *   - every call is long-running, the plain reads included. None of them return the resource;
 *     they return an Operation whose `path` you poll under /cloud/v2/.
 *   - only four classes can be written — Folder, Script, LocalScript, ModuleScript — and each
 *     has a fixed property set. Anything else is rejected, so it is checked before sending.
 *
 * This reads the published place. For the place open in Studio use the `run` tool, which is
 * immediate, transactional and not restricted to four classes.
 */
export const INSTANCE_OPS = ['get', 'update', 'children'] as const;
/** The DataModel itself; every walk starts here. */
export const ROOT_INSTANCE = 'root';
/** x-oneOf "kind" discriminator on roblox.engine.InstanceDetails — these four and no others. */
export const WRITABLE_CLASSES: Record<string, string[]> = {
  Folder: [],
  Script: ['Enabled', 'RunContext', 'Source'],
  LocalScript: ['Enabled', 'RunContext', 'Source'],
  ModuleScript: ['Source'],
};
const RUN_CONTEXTS = ['Legacy', 'Server', 'Client', 'Plugin'];

function validateProperties(className: string, properties: Record<string, unknown>): void {
  const allowed = WRITABLE_CLASSES[className];
  if (!allowed) {
    throw badRequest(
      `class_name "${className}" cannot be written through the Instance API; it accepts only ${Object.keys(WRITABLE_CLASSES).join(', ')}. To change anything else, edit the place in Studio with the run tool and publish it.`,
    );
  }
  const names = Object.keys(properties);
  if (names.length === 0 && className !== 'Folder') throw badRequest(`properties is empty; ${className} accepts ${allowed.join(', ')}`);
  for (const name of names) {
    if (!allowed.includes(name)) {
      throw badRequest(`"${name}" is not a property the Instance API can set on a ${className} (it accepts ${allowed.length > 0 ? allowed.join(', ') : 'no properties'}). Property names are PascalCase.`);
    }
  }
  const runContext = properties.RunContext;
  if (runContext !== undefined && (typeof runContext !== 'string' || !RUN_CONTEXTS.includes(runContext))) {
    throw badRequest(`RunContext must be one of ${RUN_CONTEXTS.join(' | ')}`);
  }
}

/**
 * listChildren answers with a whole resource per child — resource path, parent id, empty details —
 * which pushed the DataModel root's ~90 services past the 20 KB result cap (measured 2026-09-14:
 * 50 shown, 41 cut). Its maxPageSize is not implemented, so paging cannot recover the rest. The
 * compact form keeps what an agent walks the tree with: id, name, class when the API names it, and
 * whether there is more below.
 */
export function compactChildren(body: Record<string, unknown>): Record<string, unknown> {
  const raw = Array.isArray(body.instances) ? body.instances : [];
  const children = raw.map((item) => {
    const entry = asObject(item);
    const instance = asObject(entry.engineInstance);
    const kind = Object.keys(asObject(instance.Details))[0];
    return { id: instance.Id ?? null, name: instance.Name ?? null, ...(kind ? { class: kind } : {}), has_children: entry.hasChildren === true };
  });
  const more = typeof body.nextPageToken === 'string' && body.nextPageToken !== '' ? { nextPageToken: body.nextPageToken } : {};
  return { children, count: children.length, ...more };
}

/**
 * Every Instance operation answers with an Operation; the official samples poll it by taking
 * `path` verbatim and requesting /cloud/v2/{path}. The path is instance-scoped — there is no
 * global /cloud/v2/operations/{id} — so it is never rebuilt here, only echoed back.
 */
async function settle(
  op: Record<string, unknown>,
  http: HttpClient,
  deps: ActionDeps,
  started: number,
  timeoutMs: number,
): Promise<{ state: Record<string, unknown>; operationPath: string | undefined; timedOut: boolean }> {
  const operationPath = stringField(op, 'path');
  if (op.done === true || !operationPath) return { state: op, operationPath, timedOut: false };
  const { state, timedOut } = await pollUntilDone({
    deps,
    deadline: started + timeoutMs,
    first: op,
    done: (s) => s.done === true,
    fetch: async () => asObject((await http.request({ method: 'GET', path: `${CLOUD_V2}/${operationPath}`, idempotent: true })).body),
    startMs: 500,
    maxMs: 2000,
  });
  return { state, operationPath, timedOut };
}

export async function instance(a: CloudArgs, ctx: CloudContext, http: HttpClient, deps: ActionDeps): Promise<ActionOutcome> {
  const op = need(a.op, 'op', `for instance: ${INSTANCE_OPS.join(' | ')}`);
  const p = placeFrom(a, ctx);
  const instanceId = a.instance_id ?? ROOT_INSTANCE;
  const base = `${CLOUD_V2}/universes/${p.universeId}/places/${p.placeId}/instances/${enc(instanceId)}`;
  const context = { universe_id: p.universeId, place_id: p.placeId, ids_from: p.from, instance_id: instanceId };
  const timeoutMs = a.timeout_ms ?? DEFAULT_WAIT_MS;
  const started = deps.now();

  const created = await (async (): Promise<Record<string, unknown>> => {
    switch (op) {
      case 'get':
        // GET …/instances/{instance_id} → Operation
        return asObject((await http.request({ method: 'GET', path: base, idempotent: true })).body);
      case 'children':
        // GET …/instances/{instance_id}:listChildren → Operation  (a GET despite the verb)
        return asObject((await http.request({ method: 'GET', path: `${base}:listChildren`, query: { maxPageSize: a.page_size, pageToken: a.page_token }, idempotent: true })).body);
      case 'update': {
        const className = need(a.class_name, 'class_name', `for instance update: ${Object.keys(WRITABLE_CLASSES).join(' | ')}`);
        const properties = a.properties ?? {};
        validateProperties(className, properties);
        if (instanceId === ROOT_INSTANCE) throw badRequest('instance update cannot target "root" (the DataModel itself); pass the instance_id of a Folder, Script, LocalScript or ModuleScript found with instance children');
        // PATCH …/instances/{instance_id}  body { engineInstance: { Details: { <ClassName>: { <Property>: value } } } }
        // The wrapper key is camelCase and everything inside it is PascalCase — that mix is
        // intentional in the API, not a typo.
        return asObject((await http.request({ method: 'PATCH', path: base, json: { engineInstance: { Details: { [className]: properties } } } })).body);
      }
      default:
        throw badRequest(`op "${op}" is not an instance op (use ${INSTANCE_OPS.join(' | ')})`);
    }
  })();

  const { state, operationPath, timedOut } = await settle(created, http, deps, started, timeoutMs);
  const elapsed_ms = deps.now() - started;
  if (timedOut) {
    return {
      value: {
        ...context,
        pending: true,
        operation: operationPath,
        elapsed_ms,
        note: `The operation was still running after ${elapsed_ms} ms. Every Instance API call is long-running; raise timeout_ms and try again.`,
      },
    };
  }
  if (state.error !== undefined && state.error !== null) {
    const err = asObject(state.error);
    const reason = stringField(err, 'message') ?? JSON.stringify(state.error);
    return { isError: true, value: { error: { code: 'task_failed', message: `Instance ${op} failed: ${reason}`, operation_error: state.error, ...context, operation: operationPath, elapsed_ms } } };
  }
  // `@type` is a protobuf type URL, noise to an agent.
  const response = Object.fromEntries(Object.entries(asObject(state.response)).filter(([name]) => name !== '@type'));
  const payload = op === 'children' ? compactChildren(response) : response;
  return {
    value: {
      ...context,
      ...payload,
      ...(operationPath ? { operation: operationPath } : {}),
      // Declared in the spec but not implemented server-side (Roblox staff, 2025-02-25): the service
      // returns as many children as it can whatever is sent. Said here so an agent does not page on it.
      ...(op === 'children' && a.page_size !== undefined ? { page_size_note: 'maxPageSize is not implemented by Roblox on listChildren yet; the service returned as many children as it could regardless' } : {}),
      elapsed_ms,
      note: 'This is the PUBLISHED place, not the Studio session — publish first if you expect to see recent edits, and use the run tool for the open place.',
    },
  };
}
