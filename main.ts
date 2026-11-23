// main.ts is mend, the CLI SPEC.md specifies. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none, printing what it changed or why it failed.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

type Edit = ((tree: Tree) => void) & { moves?: [string, string][] };

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

/* ------------------------------------------------------------------ */
/* Section 5: files, lines and tiered matching.                        */
/* ------------------------------------------------------------------ */

/** A file's lines, its line break, and whether it ends with one. */
interface FileView {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function fileView(text: string): FileView {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBr = text.endsWith(br);
  const parts = text.split(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

function fileText(v: FileView): string {
  return v.lines.length === 0 ? '' : v.lines.join(v.br) + (v.finalBr ? v.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function tierKey(tier: number, s: string): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndWs(s);
  return trimWs(s);
}

/**
 * The first tier (0, 1, 2; only 0 when strict) at which the old lines occur in the
 * file's lines at or after `from`, and every 0-based position where they occur there.
 * Returns null when they occur at no tier. Never called with an empty `o`.
 */
function findTier(file: string[], o: string[], strict: boolean, from = 0): { tier: number; occs: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occs: number[] = [];
    for (let i = from; i + o.length <= file.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (tierKey(t, file[i + j]!) !== tierKey(t, o[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) occs.push(i);
    }
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk. `mark` is set by a `\` line after it. */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  mark: boolean;
}

/** Split body items into old lines O and new lines N. A context line of N keeps the
 *  index of the old line it stands for, so it is written as the file's own line. */
function splitON(items: BodyItem[]): { o: string[]; n: { ctx: boolean; text: string; oIndex: number }[] } {
  const o: string[] = [];
  const n: { ctx: boolean; text: string; oIndex: number }[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      n.push({ ctx: true, text: it.text, oIndex: o.length });
      o.push(it.text);
    } else if (it.kind === 'del') {
      o.push(it.text);
    } else {
      n.push({ ctx: false, text: it.text, oIndex: -1 });
    }
  }
  return { o, n };
}

/**
 * Replace the k matched lines at `pos` with N. Context lines are written as the file's
 * own matched lines. At tier 2 every other line of N is re-indented: with F the leading
 * spaces and tabs of the file's first matched line and P those of O's first line, a
 * non-blank line of N that starts with P has that P replaced by F.
 */
function applyReplace(
  file: string[],
  pos: number,
  o: string[],
  n: { ctx: boolean; text: string; oIndex: number }[],
  tier: number,
): string[] {
  const P = o.length > 0 ? leadWs(o[0]!) : '';
  const F = o.length > 0 ? leadWs(file[pos]!) : '';
  const rep = n.map((x) => {
    if (x.ctx) return file[pos + x.oIndex]!;
    if (tier === 2 && x.text !== '' && x.text.trim() !== '' && x.text.startsWith(P)) return F + x.text.slice(P.length);
    return x.text;
  });
  return [...file.slice(0, pos), ...rep, ...file.slice(pos + o.length)];
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs.                                           */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed,
 *  `/dev/null` meaning no file, a leading `a/` or `b/` removed. */
function diffPath(raw: string): string | null {
  let s = raw.split('\t')[0]!.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;
const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let hasPair = false;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      hasPair = false;
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const items: BodyItem[] = [];
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          if (b.startsWith('\\')) {
            if (items.length > 0) items[items.length - 1]!.mark = true;
          } else if (b === '') items.push({ kind: 'ctx', text: '', mark: false });
          else if (b.startsWith(' ')) items.push({ kind: 'ctx', text: b.slice(1), mark: false });
          else if (b.startsWith('-')) items.push({ kind: 'del', text: b.slice(1), mark: false });
          else items.push({ kind: 'add', text: b.slice(1), mark: false });
          i++;
        } else break;
      }
      while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.text === '') items.pop();
      cur.hunks.push({ a: Number(m[1]), items });
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && inHeader && !hasPair) {
          cur.oldPath = diffPath(line.slice(4));
          cur.newPath = diffPath(next.slice(4));
          hasPair = true;
          i += 2;
          continue;
        }
        cur = { oldPath: diffPath(line.slice(4)), newPath: diffPath(next.slice(4)), isCreate: false, isDelete: false, hunks: [] };
        sections.push(cur);
        hasPair = true;
        inHeader = true;
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('+++ ') && cur !== null && inHeader && !hasPair) {
      cur.newPath = diffPath(line.slice(4));
      hasPair = true;
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        if (!hasPair) cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!hasPair) cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(h: Hunk): boolean {
  for (let k = h.items.length - 1; k >= 0; k--) {
    const it = h.items[k]!;
    if (it.kind === 'ctx' || it.kind === 'add') return it.mark;
  }
  return false;
}

function unifiedEdits(sections: USection[], strict: boolean): Edit[] {
  return sections.map((s) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    const isCreate = s.isCreate || oldP === null;
    const isDelete = !isCreate && (s.isDelete || newP === null);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    const edit = ((tree: Tree): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (isCreate) {
        if (newP === null) return;
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let lastMark = false;
        for (const h of s.hunks) {
          for (const it of h.items) {
            if (it.kind === 'add') {
              plus.push(it.text);
              lastMark = it.mark;
            }
          }
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastMark ? '' : '\n'));
        return;
      }
      if (isDelete) {
        if (oldP === null) return;
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      // Change, or move.
      const src = oldP!;
      const before = tree.get(src);
      if (before === null) throw new Fail('missing', src);
      const view = fileView(before);
      let d = 0;
      for (const h of s.hunks) {
        const { o, n } = splitON(h.items);
        const noEol = hunkNoEol(h);
        if (o.length === 0) {
          const oldLen = view.lines.length;
          let pos = h.a + d;
          if (pos < 0) pos = 0;
          if (pos > oldLen) pos = oldLen;
          const ins = h.items.filter((it) => it.kind === 'add').map((it) => it.text);
          view.lines = [...view.lines.slice(0, pos), ...ins, ...view.lines.slice(pos)];
          if (pos === oldLen) view.finalBr = !noEol;
          d += n.length - o.length;
        } else {
          const found = findTier(view.lines, o, strict);
          if (!found) throw new Fail('no-match', src);
          const target = h.a - 1 + d;
          let best = found.occs[0]!;
          let bestDist = Math.abs(best - target);
          for (const p of found.occs) {
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              best = p;
              bestDist = dist;
            }
          }
          const touchesEof = best + o.length === view.lines.length;
          view.lines = applyReplace(view.lines, best, o, n, found.tier);
          if (touchesEof) view.finalBr = !noEol;
          d += n.length - o.length;
        }
      }
      const text = fileText(view);
      if (isMove) {
        tree.now.set(newP!, text);
        tree.now.set(src, null);
      } else {
        tree.now.set(src, text);
      }
    }) as Edit;
    if (isMove) edit.moves = [[oldP!, newP!]];
    return edit;
  });
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                   */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let j = searchIdx - 1; j > prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
        else throw new Exit2(`error: parse ${searchIdx + 1}`);
      }
      let sep = -1;
      for (let j = searchIdx + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          sep = j;
          break;
        }
      }
      let end = -1;
      if (sep >= 0) {
        for (let j = sep + 1; j < lines.length; j++) {
          if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
            end = j;
            break;
          }
        }
      }
      if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, oldLines: lines.slice(searchIdx + 1, sep), newLines: lines.slice(sep + 1, end) });
      prevEnd = end;
      i = end + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

function srEdits(blocks: SRBlock[], strict: boolean): Edit[] {
  return blocks.map((b) => {
    const edit = ((tree: Tree): void => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const view = fileView(before);
      const found = findTier(view.lines, b.oldLines, strict);
      if (!found) throw new Fail('no-match', b.path);
      if (found.occs.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.occs[0]!;
      const nItems = b.newLines.map((t) => ({ ctx: false, text: t, oIndex: -1 }));
      view.lines = applyReplace(view.lines, pos, b.oldLines, nItems, found.tier);
      tree.now.set(b.path, fileText(view));
    }) as Edit;
    return edit;
  });
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches.                                             */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  lineNo: number;
}

const ADD_PREFIX = '*** Add File: ';
const DEL_PREFIX = '*** Delete File: ';
const UPD_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';

function parseV4A(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith(ADD_PREFIX)) {
      kind = 'add';
      path = line.slice(ADD_PREFIX.length).trim();
    } else if (line.startsWith(DEL_PREFIX)) {
      kind = 'delete';
      path = line.slice(DEL_PREFIX.length).trim();
    } else if (line.startsWith(UPD_PREFIX)) {
      kind = 'update';
      path = line.slice(UPD_PREFIX.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secLine = i + 1;
    i++;
    const raw: { text: string; idx: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith(ADD_PREFIX) || l.startsWith(DEL_PREFIX) || l.startsWith(UPD_PREFIX)) break;
      raw.push({ text: l, idx: i });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const flines: string[] = [];
      for (const r of raw) {
        if (r.text === '') flines.push('');
        else if (r.text.startsWith('+')) flines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      sections.push({ kind, path, moveTo: null, lines: flines, chunks: [], lineNo: secLine });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      sections.push({ kind, path, moveTo: null, lines: [], chunks: [], lineNo: secLine });
    } else {
      let moveTo: string | null = null;
      let j = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith(MOVE_PREFIX)) {
        moveTo = raw[0]!.text.slice(MOVE_PREFIX.length).trim();
        j = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; j < raw.length; j++) {
        const r = raw[j]!;
        const l = r.text;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
          chunks.push(cur);
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.idx + 1}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, items: [], eof: false };
              chunks.push(cur);
            } else if (l === '') {
              continue;
            } else {
              throw new Exit2(`error: parse ${r.idx + 1}`);
            }
          }
          if (l === '') cur.items.push({ kind: 'ctx', text: '', mark: false });
          else if (l.startsWith(' ')) cur.items.push({ kind: 'ctx', text: l.slice(1), mark: false });
          else if (l.startsWith('-')) cur.items.push({ kind: 'del', text: l.slice(1), mark: false });
          else cur.items.push({ kind: 'add', text: l.slice(1), mark: false });
          continue;
        }
        throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      sections.push({ kind, path, moveTo, lines: [], chunks, lineNo: secLine });
    }
  }
  return sections;
}

function v4aEdits(sections: VSection[], strict: boolean): Edit[] {
  return sections.map((s) => {
    if (s.kind === 'add') {
      const edit = ((tree: Tree): void => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      }) as Edit;
      return edit;
    }
    if (s.kind === 'delete') {
      const edit = ((tree: Tree): void => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) === null) throw new Fail('missing', s.path);
        tree.now.set(s.path, null);
      }) as Edit;
      return edit;
    }
    const isMove = s.moveTo !== null;
    const edit = ((tree: Tree): void => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (isMove && !safe(s.moveTo!)) throw new Fail('unsafe', s.moveTo!);
      const before = tree.get(s.path);
      if (before === null) throw new Fail('missing', s.path);
      if (isMove && tree.get(s.moveTo!) !== null) throw new Fail('exists', s.moveTo!);
      const view = fileView(before);
      let cursor = 0;
      for (const ch of s.chunks) {
        if (ch.anchor !== null) {
          const found = findTier(view.lines, [ch.anchor], strict, cursor);
          if (found === null) throw new Fail('no-match', s.path);
          cursor = found.occs[0]! + 1;
        }
        const { o, n } = splitON(ch.items);
        if (o.length === 0) {
          const pos = ch.eof ? view.lines.length : cursor;
          const ins = ch.items.filter((it) => it.kind === 'add').map((it) => it.text);
          view.lines = [...view.lines.slice(0, pos), ...ins, ...view.lines.slice(pos)];
          cursor = pos + ins.length;
        } else {
          const found = findTier(view.lines, o, strict, cursor);
          if (!found) throw new Fail('no-match', s.path);
          let occs = found.occs;
          if (ch.eof) occs = occs.filter((p) => p + o.length === view.lines.length);
          if (occs.length === 0) throw new Fail('no-match', s.path);
          const pos = occs[0]!;
          view.lines = applyReplace(view.lines, pos, o, n, found.tier);
          cursor = pos + n.length;
        }
      }
      const text = fileText(view);
      if (isMove) {
        tree.now.set(s.moveTo!, text);
        tree.now.set(s.path, null);
      } else {
        tree.now.set(s.path, text);
      }
    }) as Edit;
    if (isMove) edit.moves = [[s.path, s.moveTo!]];
    return edit;
  });
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(parseUnified(lines), strict)
          : kind === 'search-replace'
            ? srEdits(parseSR(lines), strict)
            : v4aEdits(parseV4A(lines), strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
      if (edit.moves) moves.push(...edit.moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: one per path whose state changed, in byte order of the paths (UTF-8).
  // A move edit's pair is one `R <old> -> <new>` line, replacing that pair's D and A
  // lines and sorting by <new>; chained moves compose (A->B then B->C reads as A->C).
  const eff = new Map<string, string>();
  for (const [o, n] of moves) {
    for (const [s, e] of [...eff]) if (e === o) eff.set(s, n);
    if (!eff.has(o)) eff.set(o, n);
  }
  const consumed = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [o, n] of eff) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out };
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
