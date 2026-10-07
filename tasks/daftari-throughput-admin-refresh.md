# Task: Localize the admin refresh button's aria-label

## Goal
The admin screen's refresh button announces itself to screen readers as the hardcoded English
"Refresh" (`src/screens/AdminScreen.tsx`, `aria-label="Refresh"`), even though the app is
bilingual and the `refresh` key already exists in both locales. Import the project's
translation hook and announce the button with `{t('refresh')}` instead.

## Constraints
- Import `useTranslation` from `../hooks/useTranslation` (the same import `ProductCatalogScreen` uses) and add `const { t } = useTranslation();` inside the `AdminScreen` component (`export default function AdminScreen`, line 22) — not in `StatCard` or `formatDate`.
- Change only the refresh button's `aria-label`; every other string, label, and aria-label on the screen (including the `Back` button) stays exactly as it is.
- Do not add or remove translation keys: `refresh` already exists in `src/i18n/en.json` and `src/i18n/sw.json`.
- Do not change behaviour, layout, or styling.

## Models
models.implementer: local-ollama/gpt-oss:20b-cloud
models.reviewer: local-ollama/gpt-oss:20b-cloud

## Verification
node_modules/.bin/tsx scripts/check-i18n.ts

## Milestones
### M1: refresh button announces with the i18n key
type: fix
verify: node_modules/.bin/tsx scripts/check-i18n.ts && grep -q "aria-label={t('refresh')}" src/screens/AdminScreen.tsx
- [ ] the refresh button's `aria-label` is `{t('refresh')}`, not the hardcoded "Refresh"
  - check: grep -q "aria-label={t('refresh')}" src/screens/AdminScreen.tsx
- [ ] the i18n coverage check still passes with both locales intact
  - check: node_modules/.bin/tsx scripts/check-i18n.ts
