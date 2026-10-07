# Task: Localize the toast dismiss control

## Goal
The toast component renders a dismiss button whose `aria-label` is a hardcoded English
string (`"Dismiss"`), even though the app is bilingual and a `dismiss` key already exists in
both locales. Replace the hardcoded label with the localized `dismiss` key so the control is
announced correctly in Swahili too.

## Constraints
- Use the existing `useTranslation()` hook from `../hooks/useTranslation`, as sibling components (`StatusBanner`, `InstallBanner`) already do.
- Do not add or remove translation keys: `dismiss` already exists in `src/i18n/en.json` and `src/i18n/sw.json`.
- Do not change toast behaviour, timing, layout, or styling — only the dismiss button's `aria-label`.

## Models
models.implementer: local-ollama/gpt-oss:20b-cloud
models.reviewer: local-ollama/gpt-oss:20b-cloud

## Verification
node_modules/.bin/tsx scripts/check-i18n.ts

## Milestones
### M1: Toast dismiss uses the i18n key
type: fix
verify: node_modules/.bin/tsx scripts/check-i18n.ts && grep -q "aria-label={t('dismiss')}" src/components/Toast.tsx
- [ ] the toast dismiss button's aria-label is `{t('dismiss')}`, not the hardcoded "Dismiss"
  - check: grep -q "aria-label={t('dismiss')}" src/components/Toast.tsx
- [ ] the i18n coverage check still passes with both locales intact
  - check: node_modules/.bin/tsx scripts/check-i18n.ts