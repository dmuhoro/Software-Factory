# Task: Localize remaining catalog strings on the pilot surface

## Goal
The product catalog screen (live in the pilot build, reachable from Settings) still shows two
hardcoded English strings — the `Restock` tooltip on the restock button and the `Cancel`
label beside `Delete product` — even though the app is bilingual and the `restock` and `cancel`
keys already exist in both locales. Replace both hardcoded strings with the existing i18n keys
so the catalog is announced correctly in Swahili too.

## Constraints
- Use the existing `useTranslation()` hook already imported in `src/screens/ProductCatalogScreen.tsx` (`const { t } = useTranslation()` at line 33).
- Do not add or remove translation keys: `restock` and `cancel` already exist in `src/i18n/en.json` and `src/i18n/sw.json`.
- Do not change behaviour, layout, styling, or the `KES` currency placeholder — only the two hardcoded strings.

## Models
models.implementer: local-ollama/gpt-oss:20b-cloud
models.reviewer: local-ollama/gpt-oss:20b-cloud

## Verification
node_modules/.bin/tsx scripts/check-i18n.ts

## Milestones
### M1: Restock tooltip uses the i18n key
type: fix
verify: node_modules/.bin/tsx scripts/check-i18n.ts && grep -q "title={t('restock')}" src/screens/ProductCatalogScreen.tsx
- [ ] the restock button's `title` is `{t('restock')}`, not the hardcoded "Restock"
  - check: grep -q "title={t('restock')}" src/screens/ProductCatalogScreen.tsx
- [ ] the i18n coverage check still passes with both locales intact
  - check: node_modules/.bin/tsx scripts/check-i18n.ts

### M2: Cancel label uses the i18n key
type: fix
depends: M1
verify: node_modules/.bin/tsx scripts/check-i18n.ts && grep -q ">{t('cancel')}</button>" src/screens/ProductCatalogScreen.tsx
- [ ] the cancel button beside "Delete product" renders `{t('cancel')}`, not the hardcoded "Cancel"
  - check: grep -q ">{t('cancel')}</button>" src/screens/ProductCatalogScreen.tsx
- [ ] the i18n coverage check still passes with both locales intact
  - check: node_modules/.bin/tsx scripts/check-i18n.ts