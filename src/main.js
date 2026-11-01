/**
 * Browser entry point: loads styles and libraries, registers the Alpine
 * component, and starts Alpine.
 *
 * @module main
 */

import './styles.css';

import Alpine from 'alpinejs';
import collapse from '@alpinejs/collapse';

import { spdxApp } from './app.js';
import { initI18n } from './i18n/index.js';
import { startDomTranslation } from './i18n/dom.js';

Alpine.plugin(collapse);

// Exposed for debugging; not required by the app itself.
window.Alpine = Alpine;

// Resolve the language (stored choice, else the browser's) before the first
// render, then keep the DOM translated through every later Alpine update.
initI18n();

Alpine.data('spdxApp', spdxApp);
Alpine.start();

startDomTranslation();
