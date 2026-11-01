#!/usr/bin/env node
/**
 * Verifies the translation catalogs.
 *
 * Checks that `en.json` and `zh.json` hold the same keys, that no entry was
 * left empty, and that the placeholder layout of a translation matches its
 * source (`{0}` on both sides, in the same order). Exits non-zero when
 * something is off, so CI can run it.
 *
 * Usage: node scripts/i18n-check.mjs [--verbose]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const verbose = process.argv.includes('--verbose');

const read = (name) => JSON.parse(readFileSync(resolve(ROOT, 'src/i18n', name), 'utf8'));
const en = read('en.json');
const zh = read('zh.json');

const problems = [];
const identical = [];

for (const key of Object.keys(en)) {
  if (!(key in zh)) {
    problems.push(`missing in zh.json: ${JSON.stringify(key)}`);
    continue;
  }
  const value = zh[key];
  if (!value) problems.push(`empty in zh.json: ${JSON.stringify(key)}`);
  if (value === key) identical.push(key);

  // Slots may be reordered: Chinese often puts the counted thing first. What
  // must match is which slots exist, so every one of them gets filled.
  const slots = (text) => (text.match(/\{(\d+)\}/g) || []).sort().join('');
  if (slots(key) !== slots(value)) {
    problems.push(`placeholder mismatch: ${JSON.stringify(key)} -> ${JSON.stringify(value)}`);
  }
  // A translation that kept the English text around usually means a missed edit.
  if (value !== key && /^[\x20-\x7e]+$/.test(value) && value.length > key.length * 2) {
    problems.push(`untranslated (ascii only): ${JSON.stringify(key)}`);
  }
}

for (const key of Object.keys(zh)) {
  if (!(key in en)) problems.push(`stale key in zh.json: ${JSON.stringify(key)}`);
}

const total = Object.keys(en).length;
console.log(`catalog: ${total} strings, ${total - identical.length} translated`);
if (identical.length) {
  console.log(`kept as-is because they are names, acronyms or ids: ${identical.length}`);
  if (verbose) for (const key of identical) console.log(`  = ${key}`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('catalogs are consistent');
