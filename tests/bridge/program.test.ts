import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileHint, isMalformedStringError, PROGRAM_FILE_MAX_BYTES, rawNewlineInsideString, rawNewlineLine, readProgramArg, readProgramFile, transportHint } from '../../bridge/src/program.js';

describe('program arguments', () => {
  it('reports the line of the first raw newline inside a quoted literal', () => {
    expect(rawNewlineLine('return #"a\\nb"')).toBeNull();
    expect(rawNewlineLine('return #"a\nb"')).toBe(1);
    // The long string spans lines 3-4, so the broken literal is on line 5.
    expect(rawNewlineLine('local ok = "fine"\n-- a "comment\nlocal s = [[x\ny]]\nlocal bad = "a\nb"')).toBe(5);
    expect(rawNewlineLine('--[[ block\n\n]]\nlocal bad = \'x\r\ny\'')).toBe(4);
    expect(fileHint('code_file', 4)).toBe('code_file has a raw newline inside a quoted literal at line 4 — fix the string in the file (use \\n, or a [[long string]])');
    expect(fileHint('predicate_file', null)).toMatch(/^predicate_file has a raw newline inside a quoted literal — /);
  });

  it('detects a raw newline inside a quoted literal but not in long strings, comments or escapes', () => {
    // Escaped \n (two characters) is what a correct transport delivers.
    expect(rawNewlineInsideString('return #"a\\nb"')).toBe(false);
    expect(rawNewlineInsideString('return ("x\\ny"):find("[^\\n]+")')).toBe(false);
    // A real newline inside the quotes is the heredoc bug.
    expect(rawNewlineInsideString('return #"a\nb"')).toBe(true);
    expect(rawNewlineInsideString("local s = 'x\r\ny'")).toBe(true);
    expect(rawNewlineInsideString('local ok = "fine"\nlocal bad = "a\nb"')).toBe(true);
    // Long strings, comments and backslash-newline continuations are legal.
    expect(rawNewlineInsideString('local s = [[a\nb]]')).toBe(false);
    expect(rawNewlineInsideString('local s = [==[a\n"b]==]\nreturn s')).toBe(false);
    expect(rawNewlineInsideString('-- a "quote\nreturn 1')).toBe(false);
    expect(rawNewlineInsideString('--[[ block "\n ]] return "ok"')).toBe(false);
    expect(rawNewlineInsideString('local s = "line\\\ncontinued"')).toBe(false);
    expect(rawNewlineInsideString('local s = "unterminated')).toBe(false);
    expect(isMalformedStringError('StudioLiveProgram:3: Malformed string')).toBe(true);
    expect(isMalformedStringError('boom')).toBe(false);
    expect(isMalformedStringError(undefined)).toBe(false);
    expect(transportHint('code_file')).toBe('your transport turned \\n into a newline — pass code from a file (code_file)');
  });

  describe('files', () => {
    let dir: string;
    beforeAll(async () => {
      dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-live-program-'));
    });
    afterAll(async () => {
      await fsp.rm(dir, { recursive: true, force: true });
    });

    it('reads program files (absolute path, UTF-8, BOM stripped) and refuses ambiguous or unusable arguments', async () => {
      const file = path.join(dir, 'p.luau');
      await fsp.writeFile(file, '\uFEFFreturn #"a\\nb" -- é\n', 'utf8');
      expect(await readProgramFile(file, 'code_file')).toBe('return #"a\\nb" -- é\n');
      expect(await readProgramArg(undefined, file, 'code', true)).toBe('return #"a\\nb" -- é\n');
      expect(await readProgramArg('inline', undefined, 'code', true)).toBe('inline');
      expect(await readProgramArg(undefined, undefined, 'code', false)).toBeUndefined();
      await expect(readProgramArg(undefined, undefined, 'code', true)).rejects.toMatchObject({ code: 'bad_request', message: 'code (or code_file) is required' });
      await expect(readProgramArg('x', file, 'code', true)).rejects.toMatchObject({ code: 'bad_request', message: 'code and code_file are mutually exclusive' });
      await expect(readProgramArg(undefined, 'relative.luau', 'code', true)).rejects.toMatchObject({ code: 'bad_request', message: /absolute path/ });
      await expect(readProgramArg(undefined, path.join(dir, 'missing.luau'), 'predicate', true)).rejects.toMatchObject({ code: 'bad_request', message: /predicate_file not found/ });
      await fsp.writeFile(path.join(dir, 'empty.luau'), '   \n', 'utf8');
      await expect(readProgramArg(undefined, path.join(dir, 'empty.luau'), 'source', true)).rejects.toMatchObject({ code: 'bad_request', message: /source_file is empty/ });
      // Size is checked before the read: a wrong path (a log, a place file) never reaches the hub.
      await fsp.writeFile(path.join(dir, 'big.luau'), Buffer.alloc(PROGRAM_FILE_MAX_BYTES + 1, 0x2d), 'utf8');
      await expect(readProgramFile(path.join(dir, 'big.luau'), 'code_file')).rejects.toMatchObject({ code: 'bad_request', message: /code_file is too large \(4097 KB; the limit is 4 MB\)/ });
      await expect(readProgramFile(dir, 'code_file')).rejects.toMatchObject({ code: 'bad_request', message: /code_file is not a file/ });
    });
  });
});
