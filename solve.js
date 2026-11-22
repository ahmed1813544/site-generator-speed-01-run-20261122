// A fast drop-in for makefun-site 1.0.0: run(input) returns exactly the output tree
// makefun-site's build returns for one case's site, byte for byte. Written from the
// vendor README and code as the reference, re-implemented for speed: the Markdown
// renderer works in one fused pass with run-based inline rendering (no per-character
// escaping, no token objects), front matter is scanned by hand, slugs take an ASCII
// fast path with a per-case cache, and templates are compiled to small functions.
// Nothing is kept from one run() call to the next: every per-case cache lives in
// the build state created inside run().

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The HTML escape table: & < > " ' and nothing else. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function esc(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** Whether a code is one of the characters JavaScript's \s matches. */
function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
    c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}

/** The slug of `text`, as makefun-site defines it (NFKD, combining marks dropped, A-Z
 * lowered, every run of other characters one "-", none at either end, at most 64
 * characters with a "-" left at the cut dropped, "untitled" when nothing is left).
 * ASCII text is unchanged by NFKD and holds no combining marks, so it skips both. */
function slugifyCompute(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    while (i < len && isWsCode(text.charCodeAt(i))) i++;
    if (i >= len) break;
    n++;
    while (i < len && !isWsCode(text.charCodeAt(i))) i++;
  }
  return n;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const TRAIL_WS_RE = /[ \t]+$/;
const DATE_ERR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    const len = raw.length;
    if (len < 2 || raw.charCodeAt(len - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < len - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === len - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** A date value: YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31. */
function dateValue(raw) {
  if (raw.length !== 10) return { error: DATE_ERR };
  for (let i = 0; i < 10; i++) {
    const c = raw.charCodeAt(i);
    if (i === 4 || i === 7) {
      if (c !== 45) return { error: DATE_ERR };
    } else if (c < 48 || c > 57) return { error: DATE_ERR };
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: DATE_ERR };
  return { value: raw };
}

/** A tags value: [a, b, c], each name trimmed, none empty or holding ", [ or ]. */
function tagsValue(raw) {
  if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const tags = inner.split(',').map((t) => t.trim());
  for (const t of tags) {
    if (t === '' || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
  }
  return { value: tags };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return dateValue(raw);
    case 'tags':
      return tagsValue(raw);
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function blankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason
 * it is refused. `text` has "\n" line ends. The closing line is found before any line
 * is judged, so a source with no closing line is refused for that, whatever its lines hold.
 */
function parseFrontMatter(text) {
  let eol = text.indexOf('\n');
  if ((eol === -1 ? text : text.slice(0, eol)) !== '---') return { error: 'no front matter' };
  let cur = eol === -1 ? text.length : eol + 1;
  let closeIdx = -1;
  let closeEnd = -1;
  let idx = 1;
  while (cur <= text.length) {
    eol = text.indexOf('\n', cur);
    const end = eol === -1 ? text.length : eol;
    if (text.slice(cur, end) === '---') {
      closeIdx = idx;
      closeEnd = eol === -1 ? text.length : eol + 1;
      break;
    }
    if (eol === -1) break;
    cur = eol + 1;
    idx++;
  }
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const data = {};
  cur = text.indexOf('\n') + 1;
  for (let i = 1; i < closeIdx; i++) {
    eol = text.indexOf('\n', cur);
    const line = text.slice(cur, eol);
    if (!blankLine(line) && line.charCodeAt(0) !== 35) {
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${i + 1} is not "key: value"` };
      raw = raw.replace(TRAIL_WS_RE, '');
      const key = line.slice(0, k);
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    cur = eol + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

const BLANK_RE = /^[ \t]*$/;
const WS_RE = /\s/;

/** The characters a backslash escapes. */
const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h === line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let s = h;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let end = line.length;
  while (end > s && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === s) return null;
  return { depth: h, text: line.slice(s, end) };
}

/** Whether `line` is a thematic break. */
function hrLine(line) {
  let p = -1;
  if (line.startsWith('---')) p = 3;
  else if (line.startsWith('***')) p = 3;
  else return false;
  for (let j = p; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break.
 * One scan instead of four separate tests, since paragraph lines are the common case. */
function endsParagraph(line) {
  const n = line.length;
  if (n === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) {
    for (let j = 1; j < n; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  if (c0 === 96) {
    if (line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
    let j = 3;
    while (j < n) {
      const c = line.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
      else break;
    }
    while (j < n) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) return false;
      j++;
    }
    return true;
  }
  if (c0 === 35) {
    let h = 0;
    while (h < n && line.charCodeAt(h) === 35) h++;
    if (h === 0 || h > 6 || h === n) return false;
    const c = line.charCodeAt(h);
    if (c !== 32 && c !== 9) return false;
    let s = h;
    while (s < n && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
    let end = n;
    while (end > s && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
    return end !== s;
  }
  if (c0 === 45 || c0 === 42) {
    if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
    for (let j = 3; j < n; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }
  return false;
}

/** A bullet list item's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { text: line.slice(2) };
  return null;
}

/** An ordered list item's start number and text, or null. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length && j < 9) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j === line.length) return false;
  return !isWsCode(line.charCodeAt(j));
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that end an ordinary run in inline rendering. */
const SP_RE = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. The regex engine finds the
 * next mark, so ordinary runs (no escapable character and no inline mark) are copied
 * whole; only the marks are handled one by one. The shared regex is re-entrant: every
 * call sets lastIndex on entry and after each mark, so a nested call cannot disturb
 * the outer scan.
 */
function inline(s, env) {
  let out = '';
  let i = 0;
  SP_RE.lastIndex = 0;
  let m;
  while ((m = SP_RE.exec(s)) !== null) {
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = m[0];
    if (c === '\\') {
      if (j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
        const nx = s[j + 1];
        out += ESCAPES[nx] === undefined ? nx : ESCAPES[nx];
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${esc(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        out += `<a href="${esc(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
        i = mm + 1;
      } else {
        out += '[';
        i = j + 1;
      }
    } else {
      out += ESCAPES[c];
      i = j + 1;
    }
    SP_RE.lastIndex = i;
  }
  if (s.length > i) out += s.slice(i);
  return out;
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and its inline
 * HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, S) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (BLANK_RE.test(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : `${esc(body.join('\n'))}\n`}</code></pre>`);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(S.slugify(hd.text), ids);
      const html = inline(hd.text, env);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (hrLine(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const mm = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (mm !== null) {
          items.push([trimLine(mm.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const parts of items) html += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      html += `</${tag}>`;
      blocks.push(html);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path`'s first name in the scope chain: the nearest scope holding it. */
function lookup(scope, name) {
  let s = scope;
  while (s !== null) {
    if (Object.hasOwn(s.vars, name)) return s.vars[name];
    s = s.parent;
  }
  return undefined;
}

/** The next name of a path: an own property of the value so far, or undefined. */
function getProp(v, k) {
  if (v === null || typeof v !== 'object') return undefined;
  if (!Object.hasOwn(v, k)) return undefined;
  return v[k];
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The helpers a compiled template calls: one frozen object, shared by every case. */
const H = Object.freeze({ esc, txt: textOf, lk: lookup, get: getProp, truthy });

/** A path's expression in generated code, read in scope `sc`. */
function pathExpr(path, sc) {
  let e = `H.lk(${sc},${JSON.stringify(path[0])})`;
  for (let k = 1; k < path.length; k++) e = `H.get(${e},${JSON.stringify(path[k])})`;
  return e;
}

/**
 * A template's nodes compiled to a function (H, T, sc, d) returning its rendering:
 * H the helpers, T the compiled templates by name, sc the scope chain, d the include
 * depth. A for loop's frame binds its element under a computed key, as the reference
 * does, so a name like "__proto__" still becomes an own property.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const gen = (ns, sc) => {
    let src = '';
    for (const n of ns) {
      if (n.kind === 'text') src += `o.push(${JSON.stringify(n.text)});`;
      else if (n.kind === 'var') src += `o.push(H.esc(H.txt(${pathExpr(n.path, sc)})));`;
      else if (n.kind === 'raw') src += `o.push(H.txt(${pathExpr(n.path, sc)}));`;
      else if (n.kind === 'if') {
        src += `if(H.truthy(${pathExpr(n.path, sc)})!==${n.not}){`;
        src += gen(n.then, sc);
        src += `}`;
        if (n.else !== null) {
          src += `else{`;
          src += gen(n.else, sc);
          src += `}`;
        }
      } else if (n.kind === 'for') {
        const xs = `_x${uid++}`;
        const sc2 = `_s${uid++}`;
        const k = `_k${uid++}`;
        src += `{const ${xs}=${pathExpr(n.path, sc)};if(Array.isArray(${xs})){for(let ${k}=0;${k}<${xs}.length;${k}++){const ${sc2}={vars:{[${JSON.stringify(n.name)}]:${xs}[${k}],loop:{index:${k}+1,first:${k}===0,last:${k}===${xs}.length-1,length:${xs}.length}},parent:${sc}};`;
        src += gen(n.body, sc2);
        src += `}}}`;
      } else if (n.kind === 'include') {
        src += `{const _f=T.get(${JSON.stringify(n.name)});if(_f!==undefined&&d<8)o.push(_f(H,T,${sc},d+1));}`;
      }
    }
    return src;
  };
  return new Function('H', 'T', 'sc', 'd', `let o=[];${gen(nodes, 'sc')}return o.join('');`);
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** `site.base_url` with its trailing slashes dropped. */
function stripBase(baseUrl) {
  let e = baseUrl.length;
  while (e > 0 && baseUrl.charCodeAt(e - 1) === 47) e--;
  return baseUrl.slice(0, e);
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it; built once per source and kept on it. */
function cardOf(S, s) {
  let c = s._card;
  if (c === undefined) {
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s._card = c;
  }
  return c;
}

/** A page as its layout reads it. */
function pageOf(S, s) {
  const c = cardOf(S, s);
  return {
    ...c,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** A source's tags, each slug once, in its own order. */
function ownTags(S, s) {
  const seen = new Set();
  const out = [];
  for (const name of s.data.tags ?? []) {
    const sl = S.slugify(name);
    if (seen.has(sl)) continue;
    seen.add(sl);
    out.push(name);
  }
  return out;
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
export function run(input) {
  const S = {
    input,
    base: stripBase(input.site.base_url),
    templates: new Map(),
    report: [],
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    posts: [],
    tags: [],
    output: {},
    slugify: (() => {
      const cache = new Map();
      return (text) => {
        const hit = cache.get(text);
        if (hit !== undefined) return hit;
        const out = slugifyCompute(text);
        cache.set(text, out);
        return out;
      };
    })(),
  };

  // 2. Templates, parsed in code-unit order of their name; one that does not parse
  // is reported and left out, as if it were not there.
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      S.templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      S.report.push(err.message);
    }
  }

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      S.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else S.statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  // The checks run in order: front matter, the generator's own directories, a post
  // with no date, a layout that is no template, then a draft.
  const kept = [];
  for (const s of S.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      S.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      S.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      S.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!S.templates.has(layout)) {
      S.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      S.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  S.sources = kept;

  // Permalinks: each page's output directory and url, its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of S.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? S.slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${S.base}/${s.outDir}/`;
    S.bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved to the pages and static files they name.
  const staticPaths = new Set(S.statics.map((f) => f.path));
  for (const s of S.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && S.bySource.has(path)) return `${S.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${S.base}/${path}${frag}`;
        S.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, S);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug in code-unit order.
  const posts = S.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  S.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order, ordered
  // by count of posts, most first, then by slug.
  const bySlug = new Map();
  for (const p of S.posts) {
    p.tagRefs = [];
    for (const name of ownTags(S, p)) {
      const slug = S.slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${S.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of S.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(S, s).map((name) => bySlug.get(S.slugify(name)) ?? { name, slug: S.slugify(name), url: '', posts: [] });
    }
  }
  S.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: S.base };
  const allTags = S.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = S.posts.slice(0, input.site.recent).map((p) => cardOf(S, p));
  const render = (name, vars) => {
    const fn = S.templates.get(name);
    if (fn === undefined) return null;
    return fn(H, S.templates, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0);
  };
  for (const s of S.sources) S.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(S, s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(S.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${S.base}/` : `${S.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: S.posts.slice((k - 1) * per, k * per).map((p) => cardOf(S, p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) S.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of S.tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(S, p)) } });
    if (html !== null) S.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) S.output['tags/index.html'] = tagsHtml;
  for (const f of S.statics) {
    if (Object.hasOwn(S.output, f.path)) S.report.push(`shadowed ${f.path}: a built page has its path`);
    else S.output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse,
  // sorted, then the counts.
  const lines = [...S.report, ...S.broken].sort(byCodeUnits);
  const pageCount = S.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${S.posts.length} posts, ${S.tags.length} tags and ${S.statics.length} static files`);
  S.output['build-report.txt'] = `${lines.join('\n')}\n`;
  return S.output;
}
