// main.ts is mend, the CLI SPEC.md specifies. It reads one patch in any of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none, printing what it changed or why it failed.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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
  /** Successful moves, in order: [old path, new path]. Only used to print `R` lines. */
  readonly moves: Array<[string, string]> = [];
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

/** A file as lines: its break, its lines, whether it ends with a break (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, finalBreak: false };
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBreak ? s.br : '');
}

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function normLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? trimEndWS(s) : trimBothWS(s);
}

/** Every 0-based position where O matches the file's lines at this tier (SPEC.md section 5). */
function occurrencesAt(fileLines: string[], old: string[], tier: number): number[] {
  const o = old.map((l) => normLine(l, tier));
  const out: number[] = [];
  for (let i = 0; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(fileLines[i + j]!, tier) !== o[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs, with its positions. */
function findTier(fileLines: string[], old: string[], strict: boolean): { tier: number; occ: number[] } | null {
  if (old.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(fileLines, old, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a fresh line. */
interface NewLine {
  text: string;
  context: boolean;
  ctxIndex: number;
}

function ctxLine(text: string, indexInOld: number): NewLine {
  return { text, context: true, ctxIndex: indexInOld };
}

function freshLine(text: string): NewLine {
  return { text, context: false, ctxIndex: -1 };
}

/** The lines that replace the matched lines: context lines from the file, the rest re-indented at tier 2. */
function buildNew(fileLines: string[], at: number, old: string[], n: NewLine[], tier: number): string[] {
  const f = tier === 2 ? leadWS(fileLines[at]!) : '';
  const p = tier === 2 ? leadWS(old[0]!) : '';
  const out: string[] = [];
  for (const item of n) {
    if (item.context) {
      out.push(fileLines[at + item.ctxIndex]!);
      continue;
    }
    const t = item.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

/* ---------------- unified diffs (SPEC.md section 6) ---------------- */

interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  bsAfterLastCtxPlus: boolean;
  bsAfterLastPlus: boolean;
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  hdrOld?: string | null;
  hdrNew?: string | null;
  renFrom: string | null;
  renTo: string | null;
  createFlag: boolean;
  delFlag: boolean;
  hunks: Hunk[];
}

const isPlusPlus = (l: string | undefined): boolean => l !== undefined && l.startsWith('+++ ');

function parseDiffGit(line: string, num: number): [string, string] {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${num}`);
  return [m[1]!, m[2]!];
}

/** A path from a `--- ` / `+++ ` header line: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  let q = (tab < 0 ? raw : raw.slice(0, tab)).trim();
  if (q.startsWith('a/') || q.startsWith('b/')) q = q.slice(2);
  return q === '/dev/null' ? null : q;
}

function parseHunk(lines: string[], h: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(lines[h]!);
  if (m === null) throw new Exit2(`error: parse ${h + 1}`);
  const a = Number(m[1]);
  let j = h + 1;
  const body: string[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && isPlusPlus(lines[j + 1])) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    const l = body[k]!;
    if (l === '' || l[0] === ' ') lastCtxPlus = k;
    else if (l[0] === '+') {
      lastCtxPlus = k;
      lastPlus = k;
    }
  }
  const after = (k: number): boolean => body[k + 1] !== undefined && body[k + 1]!.startsWith('\\');
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) continue;
    if (l === '') {
      o.push('');
      n.push(ctxLine('', o.length - 1));
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push(ctxLine(t, o.length - 1));
    } else if (l[0] === '-') o.push(l.slice(1));
    else if (l[0] === '+') n.push(freshLine(l.slice(1)));
  }
  return {
    hunk: {
      a,
      o,
      n,
      bsAfterLastCtxPlus: lastCtxPlus >= 0 && after(lastCtxPlus),
      bsAfterLastPlus: lastPlus >= 0 && after(lastPlus),
    },
    next: j,
  };
}

function applyUnifiedHunks(state: FileState, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), state.lines.length);
      const inserted = h.n.filter((x) => !x.context).map((x) => x.text);
      const touchesEnd = at === state.lines.length;
      state.lines.splice(at, 0, ...inserted);
      if (touchesEnd) state.finalBreak = !h.bsAfterLastCtxPlus;
      d += inserted.length;
      continue;
    }
    const found = findTier(state.lines, h.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const touchesEnd = best + h.o.length === state.lines.length;
    const repl = buildNew(state.lines, best, h.o, h.n, found.tier);
    state.lines.splice(best, h.o.length, ...repl);
    if (touchesEnd) state.finalBreak = !h.bsAfterLastCtxPlus;
    d += repl.length - h.o.length;
  }
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldP = s.hdrOld !== undefined ? s.hdrOld : s.renFrom ?? s.diffOld;
  const newP = s.hdrNew !== undefined ? s.hdrNew : s.renTo ?? s.diffNew;
  const create = oldP === null || s.createFlag;
  const del = newP === null || s.delFlag;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (create) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) for (const item of h.n) if (!item.context) plus.push(item.text);
      let endsBreak = true;
      for (let k = s.hunks.length - 1; k >= 0; k -= 1) {
        const h = s.hunks[k]!;
        if (h.n.some((x) => !x.context)) {
          endsBreak = !h.bsAfterLastPlus;
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (endsBreak ? '\n' : ''));
      return;
    }
    if (del) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const op = oldP!;
    const text = tree.get(op);
    if (text === null) throw new Fail('missing', op);
    if (newP !== null && newP !== op) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const state = splitFile(text);
      applyUnifiedHunks(state, s.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(newP, joinFile(state));
      tree.moves.push([op, newP]);
      return;
    }
    const state = splitFile(text);
    applyUnifiedHunks(state, s.hunks, strict, op);
    tree.now.set(op, joinFile(state));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const fresh = (): Section => ({
    diffOld: null,
    diffNew: null,
    hdrOld: undefined,
    hdrNew: undefined,
    renFrom: null,
    renTo: null,
    createFlag: false,
    delFlag: false,
    hunks: [],
  });
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      if (line.startsWith('diff --git ')) {
        const [a, b] = parseDiffGit(line, i + 1);
        cur = fresh();
        cur.diffOld = a;
        cur.diffNew = b;
        sections.push(cur);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && isPlusPlus(lines[i + 1])) {
        cur = fresh();
        sections.push(cur);
        continue;
      }
      i += 1;
      continue;
    }
    if (cur.hunks.length === 0) {
      if (line.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        i = h.next;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        const [a, b] = parseDiffGit(line, i + 1);
        cur = fresh();
        cur.diffOld = a;
        cur.diffNew = b;
        sections.push(cur);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ')) {
        if (!isPlusPlus(lines[i + 1])) throw new Exit2(`error: parse ${i + 2}`);
        cur.hdrOld = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.hdrNew = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.createFlag = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFlag = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const [a, b] = parseDiffGit(line, i + 1);
      cur = fresh();
      cur.diffOld = a;
      cur.diffNew = b;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && isPlusPlus(lines[i + 1])) {
      cur = fresh();
      sections.push(cur);
      continue;
    }
    if (line.startsWith('@@')) {
      const h = parseHunk(lines, i);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/* ---------------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------------- */

function searchReplaceEdit(path: string, old: string[], nw: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, nw.length === 0 ? '' : nw.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const state = splitFile(text);
    const found = findTier(state.lines, old, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const repl = buildNew(
      state.lines,
      at,
      old,
      nw.map((t) => freshLine(t)),
      found.tier,
    );
    state.lines.splice(at, old.length, ...repl);
    tree.now.set(path, joinFile(state));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    let end = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      const l = lines[j]!;
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      if (sep === -1 && l.trimEnd() === '=======') {
        sep = j;
        continue;
      }
      if (sep !== -1 && l.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (sep === -1 || end === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchLine + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/* ---------------- V4A patches (SPEC.md section 8) ---------------- */

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function applyV4aChunk(state: FileState, chunk: V4aChunk, cursor: number, strict: boolean, path: string): number {
  let cur = cursor;
  if (chunk.anchor !== null) {
    let found: { tier: number; pos: number } | null = null;
    for (const t of strict ? [0] : [0, 1, 2]) {
      const occ = occurrencesAt(state.lines, [chunk.anchor], t).filter((p) => p >= cur);
      if (occ.length > 0) {
        found = { tier: t, pos: occ[0]! };
        break;
      }
    }
    if (found === null) throw new Fail('no-match', path);
    cur = found.pos + 1;
  }
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const l of chunk.body) {
    if (l === '') {
      o.push('');
      n.push(ctxLine('', o.length - 1));
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push(ctxLine(t, o.length - 1));
    } else if (l[0] === '-') o.push(l.slice(1));
    else if (l[0] === '+') n.push(freshLine(l.slice(1)));
  }
  if (o.length === 0) {
    const at = chunk.eof ? state.lines.length : cur;
    const inserted = n.filter((x) => !x.context).map((x) => x.text);
    state.lines.splice(at, 0, ...inserted);
    return at + inserted.length;
  }
  let chosen: { tier: number; pos: number } | null = null;
  for (const t of strict ? [0] : [0, 1, 2]) {
    const occ = occurrencesAt(state.lines, o, t).filter(
      (p) => p >= cur && (!chunk.eof || p + o.length === state.lines.length),
    );
    if (occ.length > 0) {
      chosen = { tier: t, pos: occ[0]! };
      break;
    }
  }
  if (chosen === null) throw new Fail('no-match', path);
  const repl = buildNew(state.lines, chosen.pos, o, n, chosen.tier);
  state.lines.splice(chosen.pos, o.length, ...repl);
  return chosen.pos + repl.length;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      i += 1;
      const raw: Array<{ t: string; n: number }> = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ t: lines[i]!, n: i + 1 });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.t.startsWith('+')) fileLines.push(r.t.slice(1));
        else if (r.t === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.n}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      i += 1;
      while (i < last && !isSectionStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const updateLine = i + 1;
      i += 1;
      const raw: Array<{ t: string; n: number }> = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ t: lines[i]!, n: i + 1 });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.t.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.t.slice(13).trim();
        idx = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (; idx < raw.length; idx += 1) {
        const r = raw[idx]!;
        const t = r.t;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(cur);
          continue;
        }
        if (t.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.n}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push(t);
          continue;
        }
        throw new Exit2(`error: parse ${r.n}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const text = tree.get(path);
        if (text === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const state = splitFile(text);
        let cursor = 0;
        for (const ch of chunks) cursor = applyV4aChunk(state, ch, cursor, strict, path);
        const out = joinFile(state);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, out);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, out);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
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
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; line: string }[] = [];
  const moved = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.original(n) === null && tree.now.get(o) === null && tree.now.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      moved.add(o);
      moved.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.line);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
