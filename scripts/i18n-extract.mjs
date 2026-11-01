#!/usr/bin/env node
/**
 * Rebuilds the translation catalogs.
 *
 * Scans the views (HTML) and the scripts that build user-facing copy (JS),
 * collects every English string the UI can show, and writes:
 *
 *   src/i18n/en.json  the full list of source strings, keyed by themselves
 *   src/i18n/zh.json  the same keys with whatever translations already exist
 *                     (new keys are added with an empty value, never dropped)
 *
 * Keys are the rendered English text, which is what the runtime looks up. A
 * count label that the app assembles at runtime (`n + ' files'`) becomes a
 * pattern key with placeholders (`{0} files`), so one entry covers every n.
 *
 * Usage: node scripts/i18n-extract.mjs [--check]
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const VIEWS_DIR = join(ROOT, 'src/views');
const EN_FILE = join(ROOT, 'src/i18n/en.json');
const ZH_FILE = join(ROOT, 'src/i18n/zh.json');

// JS files worth scanning: everything that draws chrome or writes copy. Parsers,
// graph layout, vulnerability lookups and vendored icon paths are all-ASCII
// internals and would only produce false positives.
const JS_GLOBS = ['src/config.js', 'src/changelog.js', 'src/app', 'src/lib', 'src/graph'];

// Never translatable regardless of where they appear.
const JS_SKIP_FILES = new Set([
  'src/changelog.js', // release notes stay in the language they were written in
  'src/lib/icon-paths.js',
  'src/lib/lucide-nav-icons.js',
  'src/lib/nvd-bundle.js',
  'src/lib/highlight.js',
  'src/lib/mermaid.js'
]);

// A string must look like prose, not code, a path, an id, or an SVG path.
const SVG_PATH_RE = /^[MLCQAZmlcqaz][\d\s.,\-MLAQCZmlaqcz]+$/;
const CODEISH_RE = /(=>|===|!==|\?\s*'|\{|\}|\)\s*\(|;\s*$|<\/|&[a-z]+;|\bpx\b|--\w)/;
const UTILITY_CLASS_RE =
  /(^|\s)(text|bg|border|flex|grid|inline|block|hidden|rounded|px|py|p|m|mt|mb|ml|mr|w|h|min|max|gap|space|items|justify|font|leading|tracking|opacity|shadow|ring|z|absolute|relative|fixed|sticky|overflow|transition|duration|hover|focus|md|sm|lg|xl|group)(-[\w./:[\]-]+)+(\s|$)/;

/** All .html under a directory, plus the given top-level entries. */
function collectHtml() {
  const out = [join(ROOT, 'index.html')];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.html')) out.push(full);
    }
  };
  walk(VIEWS_DIR);
  return out;
}

function collectJs() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.js')) out.push(full);
    }
  };
  for (const entry of JS_GLOBS) {
    const full = join(ROOT, entry);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full);
    else out.push(full);
  }
  return out.filter((f) => !JS_SKIP_FILES.has(relative(ROOT, f)));
}

/**
 * Whether a string reads as UI copy rather than code, a path, an id or a class.
 * @param {string} s
 * @param {{ singleWord?: boolean }} [options] `singleWord` accepts one-word
 *   labels ("Packages", "Overview"), which are exactly what nav rows and
 *   buttons show; off by default because most lone words in JS are ids.
 */
function looksLikeCopy(s, { singleWord = false, minLength = 3, loose = false } = {}) {
  if (typeof s !== 'string') return false;
  const text = s.replace(/\s+/g, ' ').trim();
  if (text.length < minLength || text.length > 400) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  if (!/\s/.test(text) && !(singleWord && /^[A-Z][A-Za-z'’-]*$/.test(text))) {
    // Loose mode also takes the small connectives a split paragraph leaves as
    // their own text node ("or", "and").
    if (!(loose && /^[a-z][a-z'’-]*$/.test(text))) return false;
  }
  if (SVG_PATH_RE.test(text)) return false;
  if (/^(https?:|mailto:|\/|\.\/|\.\.\/|#|@)/.test(text)) return false;
  if (CODEISH_RE.test(text)) return false;
  if (UTILITY_CLASS_RE.test(text)) return false;
  if (/\.(json|jsonld|js|css|html|svg|png|mjs)\b/.test(text) && text.length < 20) return false;
  // Needs at least one capitalized word or sentence punctuation to read as copy.
  if (!loose && !/(^|[.!?:\-–—(]\s+)[A-Z0-9]|^[A-Z]/.test(text) && !/[.!?]$/.test(text)) {
    return false;
  }
  return true;
}

/** Collapses whitespace the way the DOM will show it. */
function clean(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// Fragments of a larger sentence (the tail of a concatenation), font/shadow
// strings and inline SVG path data can never be looked up on their own, so they
// stay out of the catalog.
const FRAGMENT_RE = /^[,.;:)\]}]/;
const NON_COPY_RE =
  /(^|\s)\d+px\s|\d+px\s+\d+px|ui-sans-serif|system-ui|conic-gradient|translateX|rotate\(|^<|^[a-z-]+:\s/;

/** No word of three letters or more: path data, ids, unit strings. */
function hasRealWord(text) {
  return text.split(/[\s,()]+/).some((t) => /^[A-Za-z]{3,}$/.test(t));
}

/**
 * Adds a key, keeping the first sighting.
 * @param {Map<string,string>} map
 * @param {string} key
 * @param {string} origin
 * @param {{ loose?: boolean }} [options] `loose` accepts copy that starts mid
 *   sentence ("files here"), which is what a paragraph split by inline <code>
 *   produces: each fragment is its own text node and has to be looked up whole.
 */
function add(map, key, origin, { loose = false } = {}) {
  const k = clean(key);
  if (!k) return;
  // A paragraph split by an inline <span> leaves the tail as its own text node
  // (", not severity: ..."), which still needs translating.
  const fragmentOk = loose && k.length > 15;
  if ((FRAGMENT_RE.test(k) && !fragmentOk) || NON_COPY_RE.test(k)) return;
  // Unparsed expressions that leaked out of an Alpine binding.
  if ((/\s\+\s/.test(k) && /['"]/.test(k)) || /\s\?\s|\s\|\||===/.test(k)) return;
  // UI copy starts with a capital letter or a placeholder; anything else is the
  // middle of a sentence the app assembles at runtime.
  if (!loose && !/^[A-Z0-9{•"“(]/.test(k)) return;
  if (!hasRealWord(k.replace(/\{\d+\}/g, ''))) return;
  if (!map.has(k)) map.set(k, origin);
}

/**
 * Turns the template literals of one Alpine expression into catalog keys.
 *
 * `` `${filteredLicenses.length} licenses` `` renders "12 licenses", which the
 * runtime rewrites to "{0} licenses" before looking it up, so the key carries a
 * placeholder instead of the interpolation. A ternary inside the interpolation
 * (`n === 1 ? 'agent' : 'agents'`) yields one key per branch: both are separate
 * fixes phrases the user can see.
 * @param {string} expr
 * @returns {string[]}
 */
function templateKeys(expr) {
  const keys = [];
  const litRe = /`([^`]*)`/g;
  let m;
  while ((m = litRe.exec(expr))) {
    const body = m[1];
    /** Alternating literal text and slots (each slot: its possible values). */
    /** @type {Array<string|string[]>} */
    const parts = [];
    let text = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\') {
        text += body[i + 1] ?? '';
        i++;
        continue;
      }
      if (body[i] === '$' && body[i + 1] === '{') {
        let depth = 1;
        let j = i + 2;
        for (; j < body.length && depth; j++) {
          if (body[j] === '{') depth++;
          else if (body[j] === '}') depth--;
        }
        const inner = body.slice(i + 2, j - 1);
        const branches = inner.includes('?')
          ? [...inner.matchAll(/'([^']*)'/g)].map((b) => b[1]).slice(0, 2)
          : [];
        parts.push(text, branches.length ? branches : ['\uE000']);
        text = '';
        i = j - 1;
        continue;
      }
      text += body[i];
    }
    parts.push(text);
    if (parts.length < 2) continue;

    // Cartesian product of the branch slots, capped so a pathological
    // expression cannot flood the catalog.
    let combos = [''];
    for (const part of parts) {
      const options = Array.isArray(part) ? part : [part];
      const next = [];
      for (const base of combos) for (const option of options) next.push(base + option);
      combos = next.slice(0, 8);
    }

    for (const combo of combos) {
      let n = 0;
      const key = clean(combo.replace(/\uE000/g, () => `{${n++}}`));
      if (!key || !/[A-Za-z]/.test(key)) continue;
      // Needs a fixed phrase around the placeholders, otherwise it is a bare
      // interpolation with nothing to translate.
      const phrase = key
        .replace(/\{\d+\}/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!/[A-Za-z]{2,}/.test(phrase)) continue;
      keys.push(key);
    }
  }
  return keys;
}

// `title` / `label` / `group` hold visible headings; anything lower-case there
// is an internal key ('matrix', 'chips'), so only `subtitle` / `description`
// take free-form copy.
const HTML_PROP_RE =
  /\b(title|subtitle|label|description|hint|group|section)\s*:\s*['"]([^'"]+)['"]/g;
const FREE_FORM_PROPS = new Set(['subtitle', 'description', 'hint']);

function scanHtml(file, keys) {
  const html = readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '') // comments are not rendered
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');

  // Skipped regions: the raw JSON pane and the changelog body.
  const sanitized = html.replace(
    /<(\w+)[^>]*\bdata-i18n-skip\b[^>]*>[\s\S]*?<\/\1>/gi,
    '<div></div>'
  );

  // 1. Static text between tags (no interpolation).
  const textRe = />([^<>]+)</g;
  let m;
  while ((m = textRe.exec(sanitized))) {
    const raw = m[1];
    if (!/[A-Za-z]/.test(raw)) continue;
    // Must not be part of an Alpine expression block.
    const before = sanitized.slice(Math.max(0, m.index - 200), m.index);
    const openTag = before.slice(before.lastIndexOf('<'));
    if (/(x-text|x-html|x-if|x-show)\s*=\s*"[^"]*$/.test(openTag)) continue;
    const text = clean(raw.replace(/&amp;/g, '&').replace(/&mdash;/g, '—'));
    if (!looksLikeCopy(text, { singleWord: true, minLength: 2, loose: true })) continue;
    add(keys, text, file, { loose: true });
  }

  // 2. User-facing attributes.
  const attrRe = /\b(title|placeholder|aria-label|alt)="([^"]+)"/g;
  while ((m = attrRe.exec(sanitized))) {
    const value = clean(m[2]);
    if (!/[A-Za-z]/.test(value) || value.includes('${')) continue;
    if (!looksLikeCopy(value, { singleWord: true, minLength: 2, loose: true })) continue;
    add(keys, value, file, { loose: true });
  }

  // 3. Literals inside x-text / x-html / :title bindings, plus count patterns
  //    assembled as `something + ' files'`.
  // `x-data` / `x-for` only contribute the property values handled below: their
  // literals are object keys and enum values, not copy.
  const exprRe = /\b(x-text|x-html|:title|:aria-label|:placeholder|x-init|x-data|x-for)="([^"]*)"/g;
  while ((m = exprRe.exec(sanitized))) {
    const expr = m[2];
    const isBinding = !m[1].startsWith('x-data') && !m[1].startsWith('x-for');
    if (!isBinding) {
      let bound;
      while ((bound = HTML_PROP_RE.exec(expr))) {
        const text = clean(bound[2]);
        const freeForm = FREE_FORM_PROPS.has(bound[1]);
        if (!/[A-Za-z]/.test(text)) continue;
        if (!freeForm && !/^[A-Z]/.test(text)) continue;
        if (looksLikeCopy(text, { singleWord: true, loose: freeForm })) {
          add(keys, text, file, { loose: freeForm });
        }
      }
      HTML_PROP_RE.lastIndex = 0;
      continue;
    }
    const litRe = /'([^'\\]*)'|`([^`\\]*)`|"([^"\\]*)"/g;
    let lit;
    while ((lit = litRe.exec(expr))) {
      const value = lit[1] ?? lit[2] ?? lit[3] ?? '';
      if (!/[A-Za-z]/.test(value)) continue;
      // `count + ' files'` renders as "4 files": key it as a pattern.
      const isSuffix = /^\s/.test(value) && expr.slice(0, lit.index).includes('+');
      const text = clean(value.replace(/&amp;/g, '&'));
      if (isSuffix && text) {
        add(keys, `{0} ${text}`, file);
        continue;
      }
      if (looksLikeCopy(text, { singleWord: true, minLength: 2, loose: true })) {
        add(keys, text, file, { loose: true });
      }
    }
    // Count labels the template assembles, e.g. `${n} licenses`.
    for (const key of templateKeys(expr)) add(keys, key, file);
  }
}

/**
 * Turns a template literal into a catalog key: every interpolation (nested
 * braces included) becomes a numbered slot. Returns null when what is left is
 * not a sentence, only a run of placeholders: those cannot be matched safely.
 * @param {string} body
 * @returns {string|null}
 */
function templatePatternKey(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      out += body[i + 1] ?? '';
      i++;
      continue;
    }
    if (body[i] === '$' && body[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      for (; j < body.length && depth; j++) {
        if (body[j] === '{') depth++;
        else if (body[j] === '}') depth--;
      }
      out += '\uE000';
      i = j - 1;
      continue;
    }
    out += body[i];
  }
  let n = 0;
  const key = clean(out.replace(/\uE000/g, () => `{${n++}}`));
  if (!key) return null;
  // Two real words of context are what make the pattern safe to match against.
  const words = key
    .replace(/\{\d+\}/g, ' ')
    .split(/\s+/)
    .filter((w) => /[A-Za-z]{3,}/.test(w));
  if (words.length < 2) return null;
  if (!looksLikeCopy(key.replace(/\{\d+\}/g, '1'), { loose: true })) return null;
  return key;
}

function scanJs(file, keys) {
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const litRe = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = litRe.exec(src))) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    if (!/[A-Za-z]/.test(raw)) continue;
    // A template that interpolates becomes a sentence template: the runtime
    // matches it against the composed string, so "No ${x} in this document"
    // also covers "No AI models in this document".
    if (raw.includes('${')) {
      const key = templatePatternKey(raw);
      if (key) add(keys, key, file, { loose: true });
      continue;
    }
    const text = clean(raw.replace(/\\(['"`])/g, '$1'));
    if (looksLikeCopy(text)) add(keys, text, file);
    // Status lines read as sentences but can start in lower case
    // ("almost done…"), and they reach a text node like any other label.
    else if (/^[a-z][\w ,'’/-]{4,}[.…?!:]$/.test(text)) add(keys, text, file, { loose: true });
  }

  // Button labels returned from a helper ("Apply", "Remove") are single words
  // that never appear as a `label:` property.
  const returnRe = /\breturn\s+['"`]([A-Z][A-Za-z'’ -]{2,}?)['"`]/g;
  while ((m = returnRe.exec(src))) {
    const text = clean(m[1]);
    if (looksLikeCopy(text, { singleWord: true })) add(keys, text, file);
  }

  // Nav rows, palette entries, filter chips and sort options carry their copy in
  // `label` / `title` properties, one word often enough ("Packages").
  const propRe =
    /\b(label|title|subtitle|shortLabel|description|hint|placeholder|group|section)\s*:\s*['"`]([^'"`]+)['"`]/g;
  while ((m = propRe.exec(src))) {
    const text = clean(m[2]);
    if (looksLikeCopy(text, { singleWord: true })) add(keys, text, file);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Copy the scanner cannot see: a slot filled from a variable whose value is
 * itself translated (`\`× ${colNoun}\``), a suffix glued to a formatted count.
 * Keep this list short and obvious.
 */
const EXTRA_KEYS = [
  '× {0}',
  '· {0} new',
  '{0} affected items',
  'Grade {0}',
  'All',
  'Advisory',
  'Edges:',
  'Nodes:',
  'Frequency',
  'Full-text',
  'Organic',
  'Out-of-spec',
  'No requirements to plot.',
  'datasets',
  'packages',
  // A noun phrase picked by a ternary in `compatibility.js`, so it reaches the
  // DOM on its own as often as inside a sentence.
  'this document',
  'what this document ships',
  // A severity band whose chip is the literal text, not a formatted label.
  'high+',
  // Sentence tails glued to a formatted date inside an inline span.
  ', index last updated {0}',
  ', updated {0}'
];

function main() {
  const keys = new Map();
  for (const key of EXTRA_KEYS) keys.set(key, 'manual');
  for (const file of collectHtml()) scanHtml(file, keys);
  for (const file of collectJs()) scanJs(file, keys);

  const sorted = [...keys.keys()].sort((a, b) => a.localeCompare(b));
  const en = {};
  for (const key of sorted) en[key] = key;

  // Keep existing translations, add new keys empty so the check script can
  // report them instead of silently shipping English.
  const previous = readJson(ZH_FILE, {});
  const zh = {};
  let translated = 0;
  for (const key of sorted) {
    const value = typeof previous[key] === 'string' ? previous[key] : '';
    zh[key] = value;
    if (value) translated++;
  }

  const dropped = Object.keys(previous).filter((k) => !(k in en));
  writeFileSync(EN_FILE, `${JSON.stringify(en, null, 2)}\n`);
  writeFileSync(ZH_FILE, `${JSON.stringify(zh, null, 2)}\n`);

  console.log(
    `catalog: ${sorted.length} strings (${translated} translated, ${sorted.length - translated} missing)`
  );
  if (dropped.length) console.log(`removed ${dropped.length} stale key(s)`);
}

main();
