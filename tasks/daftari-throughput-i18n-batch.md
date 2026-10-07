# Task: Localize remaining hardcoded labels in Daftari screens

## Goal
Four bilingual screens still announce or label themselves in hardcoded English even though the
translation keys already exist in both locales. Replace each hardcoded string with its existing
key so the screen reader and the UI follow the selected language. No new keys are introduced;
no other behaviour changes.

## Constraints
- `back`, `cancel`, and `payment_methods` already exist in both `src/i18n/en.json` and `src/i18n/sw.json`; do not add, rename, or remove any key.
- Each unit changes exactly one screen file; import `useTranslation` from `../hooks/useTranslation` and add `const { t } = useTranslation();` inside the component only where the file does not already have it.
- Touch nothing else: no styling, layout, logic, or other labels.

## Models
models.implementer: local-ollama/gpt-oss:20b-cloud
models.reviewer: local-ollama/gpt-oss:20b-cloud

## Verification
node_modules/.bin/tsx scripts/check-i18n.ts

## Milestones
### M1: AdminScreen back button announces the back key
type: fix
verify: ! grep -q 'aria-label="Back"' src/screens/AdminScreen.tsx
- [ ] the admin screen's back button uses `aria-label={t('back')}` instead of `aria-label="Back"`
  - check: grep -q "aria-label={t('back')}" src/screens/AdminScreen.tsx

### M2: SuppliersScreen cancel button uses the translation
type: fix
verify: ! grep -q '>Cancel</button>' src/screens/SuppliersScreen.tsx
- [ ] the supplier delete-confirmation button reads `{t('cancel')}` instead of `Cancel`
  - check: grep -q ">{t('cancel')}</button>" src/screens/SuppliersScreen.tsx

### M3: PaymentMethodsScreen back button uses the translation
type: fix
verify: ! grep -q 'aria-label="Back"' src/screens/PaymentMethodsScreen.tsx
- [ ] the payment-methods back button reads `aria-label={t('back')}` and the screen imports `useTranslation`
  - check: grep -q "aria-label={t('back')}" src/screens/PaymentMethodsScreen.tsx

### M4: PaymentMethodsScreen heading uses the translation
type: fix
depends: M3
verify: grep -q "{t('payment_methods')}" src/screens/PaymentMethodsScreen.tsx
- [ ] the header title reads `{t('payment_methods')}` instead of the literal `Payment Methods`
  - check: grep -q "{t('payment_methods')}" src/screens/PaymentMethodsScreen.tsx