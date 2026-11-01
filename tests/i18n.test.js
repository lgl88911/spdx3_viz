import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { LOCALES, getLocale, setLocale, t, tf, htmlLang } from '../src/i18n/index.js';
import { sourceOf } from '../src/i18n/dom.js';

const read = (name) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../src/i18n', name), 'utf8'));

const en = read('en.json');
const zh = read('zh.json');

// The module is a singleton (the whole app shares one active locale), so each
// test puts it back where it found it.
function inLocale(code, fn) {
  const before = getLocale();
  setLocale(code, { persist: false });
  try {
    fn();
  } finally {
    setLocale(before, { persist: false });
  }
}

test('the catalogs hold the same keys', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

test('every translation keeps the placeholders of its source', () => {
  const slots = (text) => (text.match(/\{(\d+)\}/g) || []).sort().join('');
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(slots(value), slots(key), `placeholders differ for ${key}`);
  }
});

test('a known label is translated and restored', () => {
  inLocale('zh', () => {
    assert.equal(t('Packages'), '包');
    assert.equal(t('Functional Safety'), '功能安全');
  });
  inLocale('en', () => {
    assert.equal(t('Packages'), 'Packages');
  });
});

test('unknown copy is passed through untouched', () => {
  inLocale('zh', () => {
    assert.equal(t('A string nobody translated'), 'A string nobody translated');
  });
});

test('a count label matches with any number', () => {
  inLocale('zh', () => {
    assert.equal(t('12 files'), '12 个文件');
    assert.equal(t('1 file'), '1 个文件');
    // Thousands separators stay part of the captured number.
    assert.equal(t('1,204 licenses'), '1,204 个许可证');
  });
});

test('a composed sentence matches its template', () => {
  inLocale('zh', () => {
    // The catalog holds "No {0} in this document"; the app renders this.
    assert.equal(t('No AI models in this document'), '本文件中没有 AI 模型');
  });
});

test('a template with a reordered translation fills the right slots', () => {
  inLocale('zh', () => {
    // "3 of 20 packages in scope" -> "范围内的 20 个包中有 3 个"
    assert.equal(t('3 of 20 packages in scope'), '范围内的 20 个包中有 3 个');
  });
});

test('tf fills explicit arguments', () => {
  inLocale('zh', () => {
    assert.equal(tf('Grade {0}', 'D'), '等级 D');
  });
});

test('locale switching updates the language tag', () => {
  assert.equal(htmlLang('zh'), 'zh-CN');
  assert.equal(htmlLang('en'), 'en');
  assert.deepEqual(LOCALES, ['en', 'zh']);
});

test('every key has a translation or is an obvious proper noun', () => {
  for (const key of Object.keys(en)) {
    const value = zh[key];
    assert.ok(value, `no translation for ${key}`);
    if (value !== key) continue;
    // Untouched entries must have nothing to translate: a name, an acronym, a
    // licence id, a format token, or a label made only of symbols and slots.
    // All-caps words are acronyms (CVSS, SPDX, SBOM) and stay as they are even
    // when the entry also carries a slot, as in "{0} · CVSS v".
    const words = (key.replace(/\{\d+\}/g, ' ').match(/[A-Za-z]{3,}/g) || []).filter(
      (word) => !/^[A-Z0-9]+$/.test(word)
    );
    if (!words.length) continue;
    assert.match(key, /^[\p{L}\p{N} .&+/-]+$/u, `untranslated copy: ${key}`);
  }
});

// A text node keeps its indentation after the swap: the translation is spliced
// between the original spaces. Reading the source back has to compare against
// that untrimmed value, or the Chinese becomes the "source" and the UI can
// never return to English.
test('a translated node still knows its English source', () => {
  const value = '\n        拖放你的文件\n      ';
  const record = { src: 'Drop your files', out: value };
  assert.equal(sourceOf(record, value), 'Drop your files');
});

test('a rewritten node takes the value the app just wrote as its source', () => {
  const record = { src: 'Drop your files', out: '\n        拖放你的文件\n      ' };
  // Alpine re-rendered the binding: the recorded translation is gone.
  assert.equal(sourceOf(record, '\n        Drop your files\n      '), 'Drop your files');
});

test('a node seen for the first time uses its own text as the source', () => {
  assert.equal(sourceOf(undefined, '\n        Drop your files\n      '), 'Drop your files');
});
