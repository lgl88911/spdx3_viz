/**
 * DOM translation pass.
 *
 * Rather than making every template call `t()` (there are ~13k lines of views,
 * and much of the copy is produced by JS and only reaches the DOM as a text
 * node), this walks the rendered tree and swaps each text node for its
 * translation, restoring the English original when the locale goes back to EN.
 *
 * The originals are remembered per node in a WeakMap, so a switch is lossless
 * and cheap. A MutationObserver keeps Alpine-created and Alpine-updated nodes
 * translated: whenever the app writes new English into the DOM, the next frame
 * picks it up.
 *
 * @module i18n/dom
 */

import { getLocale, setLocale, t } from './index.js';

// Text inside these never gets translated: code samples, the raw JSON-LD pane,
// keyboard hints, and form fields the user types into.
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'KBD', 'SAMP', 'TEXTAREA']);

// Attributes whose value is read by users (tooltips, a11y labels, placeholders).
const TRANSLATED_ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

/** node -> { src, out }: the English the app wants, and what we last wrote. */
const textRecords = new WeakMap();
/** element -> Map(attr -> { src, out }) */
const attrRecords = new WeakMap();

let observer = null;
let scheduled = false;
let started = false;

/** Elements that opt out of translation (release notes, user data panes). */
function isOptedOut(el) {
  return el.hasAttribute?.('data-i18n-skip') || el.closest?.('[data-i18n-skip]') !== null;
}

/** Whitespace-collapsed form, which is how the catalog spells a string. */
function collapse(text) {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Works out the English source for a text node.
 *
 * A node keeps the source the app wrote even after we replace it with a
 * translation, which is what makes switching back lossless. The test is against
 * the whole node value, indentation included: the translation is spliced
 * between the original spaces, so only the untrimmed value identifies "this is
 * still what we wrote". Comparing trimmed text would read our own translation
 * back as the source and the string could never switch back to English.
 *
 * @param {{ src: string, out: string }|undefined} record What we wrote last
 * @param {string} value Current node value, untrimmed
 * @returns {string}
 */
export function sourceOf(record, value) {
  if (record && record.out === value) return record.src;
  return collapse(value);
}

function translateTextNode(node) {
  const value = node.nodeValue ?? '';
  if (!value.trim()) return;
  const core = collapse(value);

  const record = textRecords.get(node);
  const src = sourceOf(record, value);
  const out = t(src);
  if (out === core) {
    // Nothing to translate: leave the node exactly as the app wrote it.
    textRecords.set(node, { src, out: value });
    return;
  }

  const raw = value.trim();
  const start = value.indexOf(raw);
  node.nodeValue = value.slice(0, start) + out + value.slice(start + raw.length);
  // Record what the node actually holds now, whitespace and all.
  textRecords.set(node, { src, out: node.nodeValue });
}

function translateAttributes(el) {
  let records = attrRecords.get(el);
  for (const attr of TRANSLATED_ATTRS) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    const record = records?.get(attr);
    const src = record && record.out === value ? record.src : value;
    const out = t(src);
    if (!records) {
      records = new Map();
      attrRecords.set(el, records);
    }
    records.set(attr, { src, out });
    if (out !== value) el.setAttribute(attr, out);
  }
}

/**
 * Walks `root` and translates every text node and user-facing attribute.
 * @param {Node|null} root
 */
export function translateTree(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName) || isOptedOut(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        // Attributes first: an input's placeholder is user-facing even though
        // its (empty) content is not.
        translateAttributes(node);
        if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        if (node.hasAttribute('data-i18n-skip')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_REJECT;
    }
  });

  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
    node = walker.nextNode();
  }
}

/** Translates the document title from the source stored on <html>. */
function applyDocumentTitle() {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  const stored = el.dataset.i18nTitle;
  const currentTitle = document.title;
  if (!stored) {
    if (currentTitle) el.dataset.i18nTitle = currentTitle;
  }
  const src = el.dataset.i18nTitle || currentTitle;
  if (src) document.title = t(src);
}

/** Runs a full pass now (frame-batched version used by the observer). */
export function refreshDom() {
  if (typeof document === 'undefined' || !document.body) return;
  observer?.disconnect();
  translateTree(document.body);
  applyDocumentTitle();
  observer?.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATED_ATTRS
  });
}

function scheduleRefresh() {
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    refreshDom();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

/**
 * Installs the observer and translates what is already on screen. Call once,
 * after the first paint has something to translate.
 */
export function startDomTranslation() {
  if (started || typeof document === 'undefined' || !document.body) return;
  started = true;
  observer = new MutationObserver(scheduleRefresh);
  refreshDom();
}

/**
 * Applies a locale and repaints the DOM.
 * @param {string} code
 */
export function applyLocale(code) {
  setLocale(code);
  refreshDom();
}

/** The active locale, for Alpine's reactive copy. */
export function activeLocale() {
  return getLocale();
}
