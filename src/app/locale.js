/**
 * Language switching for the Alpine component.
 *
 * The catalogs and the DOM pass live in `src/i18n/`; this mixin is the bridge
 * the templates bind to (`locale`, `setLocale`, `toggleLocale`) and the place
 * where views whose text is painted on a canvas instead of the DOM get asked to
 * redraw after a switch.
 *
 * @module app/locale
 */

import { LOCALES, LOCALE_LABELS, getLocale, t, tf } from '../i18n/index.js';
import { applyLocale } from '../i18n/dom.js';

export const localeMixin = {
  /** Locale codes in menu order, and their labels (EN / 中文). */
  get localeOptions() {
    return LOCALES.map((code) => ({ code, label: LOCALE_LABELS[code] }));
  },

  /** True when the UI is not in its source language. */
  get isTranslated() {
    return this.locale !== 'en';
  },

  /**
   * Switches language. Idempotent, and safe to call before data is loaded.
   * @param {string} code
   */
  setLocale(code) {
    if (!LOCALES.includes(code) || code === this.locale) return;
    this.locale = code;
    applyLocale(code);
    // Canvas/SVG text (graph overlay, donut center, state diagram) is painted
    // from JS strings, so it needs a redraw rather than a DOM swap.
    this.$nextTick(() => this.refreshLocalizedPaint());
  },

  /** Flips between the shipped locales. Wired to the header button. */
  toggleLocale() {
    const other = LOCALES.find((code) => code !== this.locale) || LOCALES[0];
    this.setLocale(other);
  },

  /** Redraws the current view if its copy is painted, not marked up. */
  refreshLocalizedPaint() {
    try {
      if (this.currentView === 'graph') this.renderGraph();
      if (this.currentView === 'statistics') this.renderStatisticsCharts();
      if (this.currentView === 'supplychain' && this.supplyChainViewMode === 'states') {
        this.renderSupplyChainStateDiagram();
      }
    } catch {
      /* a view that is not mounted has nothing to repaint */
    }
  },

  /**
   * Translation helpers for templates whose copy is assembled in the view:
   * `x-text="tf('Grade {0}', grade)"`. Most copy needs neither, because the DOM
   * pass translates the rendered text on its own.
   */
  t(text) {
    return t(text);
  },

  tf(key, ...args) {
    return tf(key, ...args);
  },

  /** The locale the app boots in (stored choice, else browser language). */
  get initialLocale() {
    return getLocale();
  }
};
