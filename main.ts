// mend applies the four edit formats in SPEC.md (MIT).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function fileLines(text: string): FileLines {
  const lf = text.indexOf('\n');
  const br = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function fileText(file: FileLines): string {
  return file.lines.length === 0 ? '' : file.lines.join(file.br) + (file.final ? file.br : '');
}

function checkPaths(...paths: (string | null)[]): void {
  for (const p of paths) if (p !== null && !safe(p)) throw new Fail('unsafe', p);
}

function requireFile(tree: Tree, path: string): string {
  const text = tree.get(path);
  if (text === null) throw new Fail('missing', path);
  return text;
}

function parseError(line: number): never {
  throw new Exit2(`error: parse ${line}`);
}

function normalized(line: string, tier: number): string {
  if (tier === 0) return line;
  const right = line.replace(/[ \t]+$/, '');
  return tier === 1 ? right : right.replace(/^[ \t]+/, '');
}

/** Search only eligible positions before choosing the first matching tier. */
function occurrences(lines: string[], old: string[], strict: boolean, start = 0, eof = false): { positions: number[]; tier: number } | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const wanted = old.map((line) => normalized(line, tier));
    const positions: number[] = [];
    const last = lines.length - old.length;
    const first = eof ? Math.max(start, last) : start;
    for (let at = first; at <= last; at += 1) {
      if (wanted.every((line, offset) => normalized(lines[at + offset]!, tier) === line)) positions.push(at);
    }
    if (positions.length !== 0) return { positions, tier };
  }
  return null;
}

function reindent(line: string, tier: number, oldFirst: string, fileFirst: string): string {
  if (tier !== 2 || blank(line)) return line;
  const p = /^[ \t]*/.exec(oldFirst)![0];
  const f = /^[ \t]*/.exec(fileFirst)![0];
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  noBreak?: boolean;
}

function oldLines(body: BodyLine[]): string[] {
  return body.filter((line) => line.kind !== '+').map((line) => line.text);
}

/** Context comes from the matched file, including its indentation and trailing whitespace. */
function replacement(body: BodyLine[], lines: string[], old: string[], at: number, tier: number): string[] {
  let offset = 0;
  const out: string[] = [];
  for (const line of body) {
    if (line.kind === ' ') out.push(lines[at + offset]!);
    else if (line.kind === '+') out.push(reindent(line.text, tier, old[0] ?? '', lines[at] ?? ''));
    if (line.kind !== '+') offset += 1;
  }
  return out;
}

function replaceLines(file: FileLines, at: number, count: number, added: string[]): void {
  file.lines = file.lines.slice(0, at).concat(added, file.lines.slice(at + count));
}

interface UnifiedHunk {
  at: bigint;
  body: BodyLine[];
}

interface UnifiedSection {
  old: string | null;
  next: string | null;
  pair: boolean;
  renameOld?: string;
  renameNew?: string;
  create: boolean;
  delete: boolean;
  hunks: UnifiedHunk[];
}

function unifiedPath(header: string): string | null {
  const p = header.slice(4).split('\t', 1)[0]!.trim();
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  const from = section.pair ? section.old : section.renameOld ?? section.old;
  const to = section.pair ? section.next : section.renameNew ?? section.next;
  return (tree) => {
    checkPaths(from, to);
    if (from === null || section.create) {
      const path = to ?? '';
      checkPaths(path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const added = section.hunks.flatMap((hunk) => hunk.body.filter((line) => line.kind === '+'));
      tree.now.set(path, fileText({ lines: added.map((line) => line.text), br: '\n', final: !added.at(-1)?.noBreak }));
      return;
    }
    const before = requireFile(tree, from);
    if (to === null || section.delete) {
      tree.now.set(from, null);
      return;
    }
    if (from !== to && tree.get(to) !== null) throw new Fail('exists', to);
    const file = fileLines(before);
    let delta = 0;
    for (const hunk of section.hunks) {
      const old = oldLines(hunk.body);
      let at: number;
      let tier = 0;
      if (old.length === 0) {
        const target = hunk.at + BigInt(delta);
        at = target < 0n ? 0 : target > BigInt(file.lines.length) ? file.lines.length : Number(target);
      } else {
        const found = occurrences(file.lines, old, strict);
        if (found === null) throw new Fail('no-match', from);
        tier = found.tier;
        const target = hunk.at - 1n + BigInt(delta);
        const distance = (p: number): bigint => {
          const d = BigInt(p) - target;
          return d < 0n ? -d : d;
        };
        at = found.positions.reduce((best, p) => distance(p) < distance(best) ? p : best);
      }
      const added = replacement(hunk.body, file.lines, old, at, tier);
      if (at + old.length === file.lines.length) {
        const lastNew = hunk.body.findLast((line) => line.kind !== '-');
        file.final = !lastNew?.noBreak;
      }
      replaceLines(file, at, old.length, added);
      delta += added.length - old.length;
    }
    tree.now.set(to, fileText(file));
    if (from !== to) {
      tree.now.set(from, null);
      tree.moves.push({ from, to });
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | undefined;
  const start = (old: string | null, next: string | null): UnifiedSection => {
    const s: UnifiedSection = { old, next, pair: false, create: false, delete: false, hunks: [] };
    sections.push(s);
    return s;
  };
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^diff --git(?:\s|$)/.test(line)) {
      const m = /^diff --git a\/(.+) b\/(.+)$/s.exec(line);
      if (m === null) parseError(i + 1);
      section = start(m[1]!, m[2]!);
    } else if (pairAt(i)) {
      if (section === undefined || section.hunks.length !== 0 || section.pair) section = start('', '');
      section.old = unifiedPath(line);
      section.next = unifiedPath(lines[i + 1]!);
      section.pair = true;
      i += 1;
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/s.exec(line);
      if (m === null || section === undefined) parseError(i + 1);
      const raw: string[] = [];
      let end = i + 1;
      for (; end < lines.length; end += 1) {
        const body = lines[end]!;
        if (body.startsWith('diff --git ') || pairAt(end)) break;
        if (body !== '' && !' -+\\'.includes(body[0]!)) break;
        raw.push(body);
      }
      while (raw.at(-1) === '') raw.pop();
      const body: BodyLine[] = [];
      let previous: BodyLine | undefined;
      for (const text of raw) {
        if (text.startsWith('\\')) {
          if (previous !== undefined) previous.noBreak = true;
          previous = undefined;
        } else {
          previous = { kind: text === '' ? ' ' : text[0] as BodyLine['kind'], text: text.slice(1) };
          body.push(previous);
        }
      }
      section.hunks.push({ at: BigInt(m[1]!), body });
      i = end - 1;
    } else if (section !== undefined && section.hunks.length === 0) {
      if (line.startsWith('--- ')) parseError(i + 2);
      if (line.startsWith('rename from ')) section.renameOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) section.renameNew = line.slice(10).trim();
      else if (/^new file mode(?:[ \t]|$)/.test(line)) section.create = true;
      else if (/^deleted file mode(?:[ \t]|$)/.test(line)) section.delete = true;
    }
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousEnd = -1;
  let previousPath: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const search = i;
    let path: string | undefined;
    for (let j = i - 1; j > previousEnd; j -= 1) {
      const candidate = lines[j]!.trim();
      if (candidate !== '' && !candidate.startsWith('```')) {
        path = candidate;
        break;
      }
    }
    path ??= previousPath;
    if (path === undefined) parseError(search + 1);
    let separator = i + 1;
    while (separator < lines.length && lines[separator]!.trimEnd() !== '=======') {
      if (lines[separator]!.trimEnd() === '>>>>>>> REPLACE') parseError(search + 1);
      separator += 1;
    }
    let end = separator + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end += 1;
    if (end >= lines.length) parseError(search + 1);
    const old = lines.slice(i + 1, separator);
    const added = lines.slice(separator + 1, end);
    const p = path;
    edits.push((tree) => {
      checkPaths(p);
      if (old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileText({ lines: added, br: '\n', final: true }));
        return;
      }
      const file = fileLines(requireFile(tree, p));
      const found = occurrences(file.lines, old, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length !== 1) throw new Fail('ambiguous', p);
      const at = found.positions[0]!;
      const next = added.map((line) => reindent(line, found.tier, old[0]!, file.lines[at]!));
      replaceLines(file, at, old.length, next);
      tree.now.set(p, fileText(file));
    });
    previousEnd = end;
    previousPath = p;
    i = end;
  }
  return edits;
}

interface V4AChunk {
  anchor: string;
  body: BodyLine[];
  eof: boolean;
}

function v4aUpdate(path: string, move: string | undefined, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    checkPaths(path, move ?? null);
    const file = fileLines(requireFile(tree, path));
    if (move !== undefined && tree.get(move) !== null) throw new Fail('exists', move);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== '') {
        const found = occurrences(file.lines, [chunk.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.positions[0]! + 1;
      }
      const old = oldLines(chunk.body);
      let at = chunk.eof ? file.lines.length : cursor;
      let tier = 0;
      if (old.length !== 0) {
        const found = occurrences(file.lines, old, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', path);
        at = found.positions[0]!;
        tier = found.tier;
      }
      const added = replacement(chunk.body, file.lines, old, at, tier);
      replaceLines(file, at, old.length, added);
      cursor = at + added.length;
    }
    tree.now.set(move ?? path, fileText(file));
    if (move !== undefined) {
      tree.now.set(path, null);
      tree.moves.push({ from: path, to: move });
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0) parseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') parseError(first + 1);
  const last = lines.findLastIndex((line) => !blank(line));
  if (lines[last]!.trim() !== '*** End Patch') parseError(lines.length + 1);
  const edits: Edit[] = [];
  const sectionHeader = (line: string): boolean => /^\*\*\* (?:Add|Delete|Update) File: /.test(line);
  for (let i = first + 1; i < last;) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const header = /^\*\*\* (Add|Delete|Update) File: (.*)$/s.exec(lines[i]!);
    if (header === null) parseError(i + 1);
    const path = header[2]!.trim();
    let next = i + 1;
    while (next < last && !sectionHeader(lines[next]!)) next += 1;
    let end = next;
    while (end > i + 1 && blank(lines[end - 1]!)) end -= 1;
    if (header[1] === 'Add') {
      const added: string[] = [];
      for (let j = i + 1; j < end; j += 1) {
        const line = lines[j]!;
        if (line !== '' && !line.startsWith('+')) parseError(j + 1);
        added.push(line.slice(1));
      }
      edits.push((tree) => {
        checkPaths(path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileText({ lines: added, br: '\n', final: true }));
      });
    } else if (header[1] === 'Delete') {
      if (end !== i + 1) parseError(i + 2);
      edits.push((tree) => {
        checkPaths(path);
        requireFile(tree, path);
        tree.now.set(path, null);
      });
    } else {
      let j = i + 1;
      let move: string | undefined;
      if (j < end && lines[j]!.startsWith('*** Move to: ')) {
        move = lines[j]!.slice(13).trim();
        j += 1;
      }
      const chunks: V4AChunk[] = [];
      let chunk: V4AChunk | undefined;
      for (; j < end; j += 1) {
        const line = lines[j]!;
        if (line.startsWith('@@')) {
          if (chunk !== undefined) chunks.push(chunk);
          chunk = { anchor: line.slice(2).trim(), body: [], eof: false };
        } else if (line === '*** End of File') {
          if (chunk === undefined) parseError(j + 1);
          chunk.eof = true;
          chunks.push(chunk);
          chunk = undefined;
        } else if (line === '' || ' -+'.includes(line[0]!)) {
          if (chunk === undefined) {
            if (chunks.length !== 0) parseError(j + 1);
            chunk = { anchor: '', body: [], eof: false };
          }
          chunk.body.push({ kind: line === '' ? ' ' : line[0] as BodyLine['kind'], text: line.slice(1) });
        } else parseError(j + 1);
      }
      if (chunk !== undefined) chunks.push(chunk);
      if (chunks.length === 0 && move === undefined) parseError(i + 1);
      edits.push(v4aUpdate(path, move, chunks, strict));
    }
    i = next;
  }
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const changes = [...tree.now].map(([path, now]) => ({ path, now, was: tree.original(path) })).filter((c) => c.was !== c.now);
  const rows: { path: string; text: string }[] = [];
  const moved = new Set<string>();
  const movePairs = new Set<string>();
  for (const { from, to } of tree.moves) {
    const pair = JSON.stringify([from, to]);
    if (movePairs.has(pair) || tree.original(from) === null || tree.get(from) !== null || tree.original(to) !== null || tree.get(to) === null) continue;
    movePairs.add(pair);
    moved.add(from);
    moved.add(to);
    rows.push({ path: to, text: `R ${from} -> ${to}` });
  }
  for (const { path, was, now } of changes) {
    if (!moved.has(path)) rows.push({ path, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${path}` });
  }
  rows.sort((a, b) => byteOrder(a.path, b.path));
  if (!check) {
    // Remove files before creating their replacements, regardless of reporting order.
    for (const { path, now } of changes) if (now === null) rmSync(path, { force: true });
    for (const { path, now } of changes.sort((a, b) => byteOrder(a.path, b.path))) {
      if (now === null) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, now);
    }
  }
  return { code: 0, out: [...rows.map((row) => row.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
