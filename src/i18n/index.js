/**
 * Runtime translation core.
 *
 * The catalog is keyed by the English source string that the UI renders, so a
 * translation can be added without touching any template or script: the DOM
 * pass in `./dom.js` looks every visible text node up in the active locale's
 * catalog and swaps in the translation. Numbers are normalized before lookup,
 * which is what lets one entry cover every count the app can produce
 * (`"12 packages"` -> `"{0} packages"` -> `"{0} 个包"`).
 *
 * Catalogs live in `./en.json` and `./zh.json`, same keys on both sides, so the
 * two files can be diffed or edited side by side.
 *
 * @module i18n
 */

import en from './en.json' with { type: 'json' };
import zh from './zh.json' with { type: 'json' };

/** Catalogs by locale code. en.json documents what is translatable. */
const CATALOGS = { en, zh };

/** Locale codes the UI can switch between, in menu order. */
export const LOCALES = ['en', 'zh'];

/** Locale names, each written in its own language (never translated). */
export const LOCALE_LABELS = { en: 'EN', zh: '中文' };

/** Used when nothing stored or detected is available. */
export const FALLBACK_LOCALE = 'en';

const STORAGE_KEY = 'spdx3viz.locale';

// A run of digits with optional thousands separators / decimals, replaced by a
// placeholder so `"1,234 packages"` and `"7 packages"` share one catalog entry.
const NUMBER_RE = /\d[\d.,]*/g;
const PLACEHOLDER = '\u0000';
/** A catalog placeholder: `{0}`, `{1}`, … */
const SLOT = /\{(\d+)\}/g;

let current = FALLBACK_LOCALE;
/** exact source string -> translation */
let exactIndex = new Map();
/** number-normalized source string -> { value } (count labels) */
let patternIndex = new Map();
/** [{ re, value }] sentence templates whose slots match any short text */
let templateIndex = [];
/** source string -> translation (or null), so each string is matched once */
const resolved = new Map();
const listeners = new Set();

/** Replaces digit runs with a placeholder, returning the normalized text and
 * the captured groups in order.
 *
 * A catalog slot is a placeholder too: `"{0} files"` has to normalize to the
 * same thing as the rendered `"12 files"`, otherwise the count lookup can never
 * hit and every count falls through to the looser sentence matcher. */
function normalize(text) {
  const groups = [];
  const normalized = text.replace(SLOT, PLACEHOLDER).replace(NUMBER_RE, (m) => {
    groups.push(m);
    return PLACEHOLDER;
  });
  return { normalized, groups };
}

/** Escapes a literal chunk for use inside a RegExp. */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the sentence-template matcher for a key.
 *
 * A key with placeholders and real words around them (`"No {0} in this
 * document"`) matches the same sentence with any subject, which is how copy the
 * app assembles at runtime (`"No AI models in this document"`) finds its
 * translation without a `tf()` call at every site.
 *
 * A key needs at least one word of literal context, and a key with a single
 * slot has to earn a wide slot: `"{0} edges"` matches one token only, because a
 * `\S.{0,60}?` slot happily swallowed `"3 nodes · 12 edges"` and produced a
 * half-translated line. Two narrow shapes are allowed with one word of context
 * or none: a short symbol-led label (`"× {0}"`, `"{0} edges"`) and a short
 * capitalised prefix (`"Grade {0}"`). Keys with two or more slots
 * (`"{0}: {1} edges ({2})"`) keep wide slots: the surrounding literals are
 * specific enough, and each captured slot is translated on its own.
 * @param {string} key
 * @returns {RegExp|null}
 */
function templateRe(key) {
  const words = key
    .replace(SLOT, ' ')
    .split(/\s+/)
    .filter((w) => /[A-Za-z]{3,}/.test(w));
  const slots = (key.match(SLOT) || []).length;
  const symbolLed = slots === 1 && key.length <= 24 && /^[^\w\s]/.test(key);
  const capitalLed = slots === 1 && key.length <= 16 && /^[A-Z]/.test(key);
  let slot;
  if (slots === 1) {
    if (words.length < 2 && !symbolLed && !capitalLed) return null;
    slot = words.length < 2 ? '(\\S+)' : '(\\S.{0,60}?)';
  } else {
    if (!words.length) return null;
    slot = '(\\S.{0,60}?)';
  }
  const parts = key.split(SLOT).map((part, i) => (i % 2 ? slot : escapeRe(part)));
  return new RegExp(`^${parts.join('')}$`);
}

/** Builds the lookup tables for a catalog. */
function indexCatalog(catalog) {
  const exact = new Map();
  const patterns = new Map();
  const templates = [];
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value !== 'string' || !value) continue;
    exact.set(key, value);
    if (!SLOT.test(key)) continue;
    SLOT.lastIndex = 0;
    const { normalized } = normalize(key);
    if (!patterns.has(normalized)) patterns.set(normalized, value);
    const re = templateRe(key);
    // Longest literal context first, so "No {0} in this document" is tried
    // before a shorter entry that could also span the same sentence.
    if (re) templates.push({ re, value, context: key.replace(SLOT, '').length });
  }
  templates.sort((a, b) => b.context - a.context);
  return { exact, patterns, templates };
}

/** Fills `{0}`..`{n}` in a translation with the captured numbers. */
function interpolate(text, groups) {
  if (!groups.length) return text;
  return text.replace(/\{(\d+)\}/g, (m, i) => {
    const value = groups[Number(i)];
    return value === undefined ? m : value;
  });
}

/** Whether a locale code is one we ship a catalog for. */
export function isSupported(code) {
  return Object.prototype.hasOwnProperty.call(CATALOGS, code);
}

/** The active locale code. */
export function getLocale() {
  return current;
}

/** True when the active locale is not the source language. */
export function isTranslated() {
  return current !== FALLBACK_LOCALE;
}

/**
 * Translates one UI string.
 * Returns the input unchanged when the locale is English or nothing matches,
 * so callers never need a guard.
 * @param {string} text
 * @returns {string}
 */
export function t(text) {
  if (typeof text !== 'string' || current === FALLBACK_LOCALE) return text;
  const key = text.trim();
  if (!key) return text;

  const direct = exactIndex.get(key);
  if (direct !== undefined) return direct;

  const cached = resolved.get(key);
  if (cached !== undefined) return cached ?? text;

  const { normalized, groups } = normalize(key);
  const pattern = patternIndex.get(normalized);
  if (pattern !== undefined) {
    const out = interpolate(pattern, groups);
    resolved.set(key, out);
    return out;
  }

  for (const { re, value } of templateIndex) {
    const match = re.exec(key);
    if (!match) continue;
    // Each slot is itself UI copy more often than not (`"× Verifications"`), so
    // translate the captured text before pasting it in.
    const out = interpolate(
      value,
      match.slice(1).map((g) => t(g.trim()))
    );
    resolved.set(key, out);
    return out;
  }

  resolved.set(key, null);
  return text;
}

/**
 * Translates a string and fills its `{0}`..`{n}` slots, for messages built in
 * code rather than read off the DOM.
 * @param {string} text English source, with optional placeholders
 * @param {...(string|number)} args
 * @returns {string}
 */
export function tf(text, ...args) {
  const out = t(text);
  return args.length ? interpolate(out, args.map(String)) : out;
}

/** Language tag for `<html lang>`, so CSS and screen readers get a real answer. */
export function htmlLang(code = current) {
  return code === 'zh' ? 'zh-CN' : 'en';
}

function readStored() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isSupported(saved) ? saved : null;
  } catch {
    return null;
  }
}

/** Best guess at first paint: an explicit choice, else the browser's language. */
export function detectLocale() {
  const stored = readStored();
  if (stored) return stored;
  try {
    const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
    if (
      languages.some((l) =>
        String(l || '')
          .toLowerCase()
          .startsWith('zh')
      )
    )
      return 'zh';
  } catch {
    /* no navigator: keep the fallback */
  }
  return FALLBACK_LOCALE;
}

/**
 * Switches the active locale and tells the DOM layer to repaint.
 * Listeners run after the catalogs are swapped.
 * @param {string} code
 * @param {{ persist?: boolean }} [options]
 */
export function setLocale(code, { persist = true } = {}) {
  const next = isSupported(code) ? code : FALLBACK_LOCALE;
  if (next !== current) {
    current = next;
    ({
      exact: exactIndex,
      patterns: patternIndex,
      templates: templateIndex
    } = indexCatalog(CATALOGS[current]));
    resolved.clear();
  }
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode: the choice just won't survive a reload */
    }
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = htmlLang(next);
  }
  for (const fn of listeners) fn(next);
  return next;
}

/** Registers a locale-change listener; returns an unsubscribe function. */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Sets up the module. Safe to call once, from the browser entry point. */
export function initI18n() {
  ({
    exact: exactIndex,
    patterns: patternIndex,
    templates: templateIndex
  } = indexCatalog(CATALOGS[current]));
  resolved.clear();
  const code = detectLocale();
  return setLocale(code, { persist: false });
}

// Prime the indexes for the initial locale so `t()` works before initI18n().
current = detectLocale();
({
  exact: exactIndex,
  patterns: patternIndex,
  templates: templateIndex
} = indexCatalog(CATALOGS[current]));
if (typeof document !== 'undefined') document.documentElement.lang = htmlLang(current);
