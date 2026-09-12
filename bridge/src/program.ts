/**
 * Luau program arguments that reach the bridge from files (`code_file`, `source_file`,
 * `predicate_file`, `--code-file` …) and the diagnosis of the one transport bug every scripted
 * agent hits: a shell heredoc turning `\n` inside a Luau string into a real newline, which the
 * compiler reports as `Malformed string`. Nothing here touches the wire; the hub only ever sees
 * `code` / `source` / `predicate`.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BridgeError, errorMessage } from './errors.js';

/** Appended to a `syntax_error` that a raw newline inside a quoted literal explains. */
export function transportHint(fileField: string): string {
  return `your transport turned \\n into a newline — pass code from a file (${fileField})`;
}

/** The same diagnosis when the program already came from a file: the file itself holds the raw newline. */
export function fileHint(fileField: string, line: number | null): string {
  return `${fileField} has a raw newline inside a quoted literal${line !== null ? ` at line ${line}` : ''} — fix the string in the file (use \\n, or a [[long string]])`;
}

/** Largest program file the bridge reads (`push` uses the same bound); anything bigger is refused before it is read. */
export const PROGRAM_FILE_MAX_BYTES = 4 * 1024 * 1024;

/** Reads a program file for a tool argument: absolute path, ≤ 4 MB, UTF-8, BOM stripped, must not be empty. */
export async function readProgramFile(file: string, field: string): Promise<string> {
  if (!path.isAbsolute(file)) throw new BridgeError('bad_request', `${field} must be an absolute path, got "${file}"`);
  let text: string;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new BridgeError('bad_request', `${field} is not a file: ${file}`);
    if (stat.size > PROGRAM_FILE_MAX_BYTES) {
      throw new BridgeError('bad_request', `${field} is too large (${Math.ceil(stat.size / 1024)} KB; the limit is ${PROGRAM_FILE_MAX_BYTES / (1024 * 1024)} MB): ${file}`);
    }
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new BridgeError('bad_request', `${field} not found: ${file}`);
    throw new BridgeError('bad_request', `${field} could not be read (${errorMessage(err)}): ${file}`);
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  if (text.trim() === '') throw new BridgeError('bad_request', `${field} is empty: ${file}`);
  return text;
}

/**
 * Resolves an inline program argument or its `<field>_file` twin (mutually exclusive). Returns
 * undefined when neither is given and the argument is optional.
 */
export async function readProgramArg(inline: string | undefined, file: string | undefined, field: string, required: boolean): Promise<string | undefined> {
  const fileField = `${field}_file`;
  if (inline !== undefined && file !== undefined) throw new BridgeError('bad_request', `${field} and ${fileField} are mutually exclusive`);
  if (file !== undefined) return readProgramFile(file, fileField);
  if (inline !== undefined) return inline;
  if (required) throw new BridgeError('bad_request', `${field} (or ${fileField}) is required`);
  return undefined;
}

/** Level of a long bracket (`[[`, `[=[` …) opening at `i`, or null when there is none. */
function longBracketAt(code: string, i: number): number | null {
  if (code[i] !== '[') return null;
  let j = i + 1;
  while (code[j] === '=') j += 1;
  return code[j] === '[' ? j - i - 1 : null;
}

/** Index just past the closing bracket of the long string/comment opening at `i`, or the end of the text. */
function skipLong(code: string, i: number, level: number): number {
  const close = `]${'='.repeat(level)}]`;
  const end = code.indexOf(close, i + level + 2);
  return end < 0 ? code.length : end + close.length;
}

/**
 * 1-based line of the first single- or double-quoted Luau literal in `code` that contains a raw
 * newline before its closing quote — what a heredoc leaves behind — or null when there is none.
 * Long strings, comments and backslash escapes (including `\` + newline, a legal continuation) are
 * skipped; backtick strings are not examined.
 */
export function rawNewlineLine(code: string): number | null {
  const n = code.length;
  let i = 0;
  let line = 1;
  const advance = (to: number): void => {
    for (let k = i; k < to && k < n; k += 1) if (code[k] === '\n') line += 1;
    i = to;
  };
  while (i < n) {
    const c = code[i];
    if (c === '-' && code[i + 1] === '-') {
      const level = longBracketAt(code, i + 2);
      if (level !== null) {
        advance(skipLong(code, i + 2, level));
      } else {
        const nl = code.indexOf('\n', i);
        advance(nl < 0 ? n : nl + 1);
      }
      continue;
    }
    if (c === '[') {
      const level = longBracketAt(code, i);
      if (level !== null) {
        advance(skipLong(code, i, level));
        continue;
      }
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        const d = code[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === c) break;
        if (d === '\n' || d === '\r') return line;
        j += 1;
      }
      advance(j + 1);
      continue;
    }
    advance(i + 1);
  }
  return null;
}

/** True when `code` has a raw newline inside a quoted literal (see rawNewlineLine). */
export function rawNewlineInsideString(code: string): boolean {
  return rawNewlineLine(code) !== null;
}

/** The compiler's message for a string literal cut by a newline (Luau: "Malformed string"). */
export function isMalformedStringError(message: string | undefined): boolean {
  return typeof message === 'string' && /malformed string/i.test(message);
}
