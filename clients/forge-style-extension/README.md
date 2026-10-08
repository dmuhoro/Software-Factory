# Software Factory Remote Control (MV3, RAM-only token)

This is a minimal Manifest V3 extension that demonstrates the RAM-only-token pattern:
- The API key and tenant ID are held in the popup's JavaScript memory only.
- They are never written to localStorage, sessionStorage, IndexedDB, cookies, or the URL.
- Closing the popup forgets them.
- Host permissions must be updated to your deployed origin (Railway, etc.).

Usage:
1. Load unpacked in chrome://extensions (Developer mode).
2. Update `manifest.json` host_permissions to include your base URL, e.g. `"https://your-app.up.railway.app/*"`.
3. Open popup, set Base URL, Tenant ID, API Key.
4. Draft a goal or submit a run against the authenticated `/api/loop/*` endpoints.
