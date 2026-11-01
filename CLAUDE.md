# CLAUDE.md

## Writing style

- Don't use em dashes (`—`) in prose, code comments, commit messages, changelog entries, or PR text. Use a colon, comma, parentheses, or two sentences instead.

## Changelog (`CHANGELOG.md`)

- Keep entries short: one concise line, generally 10 words or less, like the existing bullets.
- Only add an entry for something genuinely notable: an important new capability, or a fix for a bug that shipped in a **previous** release. Do **not** add an entry for a bug introduced and fixed within the current unreleased cycle.
- Before adding a bullet, check whether it folds into an existing one for the same release rather than adding another line.
- After editing CHANGELOG.md, run node scripts/gen-changelog.mjs to regenerate src/changelog.js so the in-app "What's new" modal stays in sync.

## Before proposing/creating a PR

Always run these checks locally first (they mirror `.github/workflows/deploy-pages.yml` CI exactly) and fix any failures before proposing a PR:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run i18n:check
npm run build
```

## Copy and translations

- Every user-facing string is translatable: it must render as plain text in the
  DOM (the pass in `src/i18n/dom.js` swaps it), and its English form has to be in
  `src/i18n/en.json` with a Chinese counterpart in `src/i18n/zh.json`.
- After adding or changing copy, run `npm run i18n:extract`, fill the new entries
  in `zh.json`, then `npm run i18n:check`. See `docs/i18n.md`.
- Don't concatenate sentences from word fragments in JS: write one template
  literal with two or more words of fixed context so the runtime can match it, or
  call `tf()` in the template.
- Don't hardcode a language: read `this.locale`, and repaint anything drawn on a
  canvas in `refreshLocalizedPaint()`. Release notes stay English
  (`data-i18n-skip`).
