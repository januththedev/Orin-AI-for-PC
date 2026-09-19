# orinai.org backend contract — everything the PC app needs (v1)

Single page for the backend implementer. Base: `https://orinai.org`
(override via `ORIN_API_BASE` env on the PC for staging). Auth is Bearer
session tokens unless noted. Timeouts the PC enforces are listed — the
server should always answer faster, and MUST never hang: on timeout the PC
shows a network error, never a frozen screen.

Detail specs: Clerk flows → `docs/CLERK-BRIDGE.md`; chat routing →
`docs/OMNIROUTE-BACKEND.md`. Field names below are frozen — the PC parses
them exactly.

## Endpoints

### `GET /api/health` (new, optional but recommended)
Powers Settings → Account → Test connection. Any HTTP status counts as
alive on the PC side (even 404 — it only checks reachability + latency).
- `200 { "ok": true }` ideal; anything else still proves liveness.

### `POST /api/chat`
Answers user queries for signed-in users (chat + agent turns alike).
- Auth: `Authorization: Bearer <session_token>`.
- Body: `{ "mode": "chat", "model": "orin-pro" | "orin-flash", "prompt": "…", "history": [{ "role", "content" }] }`.
- Success: `{ "text": "…" }` (full answer, non-streaming).
- `401` → PC says "sign in again". `429` → PC says "plan limit, resets
  daily". Other errors → shown as `Orin AI error {status}`.
- PC timeout: 180s (router retries server-side must fit inside it).

### `POST /api/auth/password`
Legacy email/phone + password (Firebase family).
- Login body: `{ "action": "login", "identifier": "…", "password": "…" }`.
- Register body: `{ "action": "register", "name": "…", "identifier": "…", "password": "…" }`.
- Success: `{ "customToken": "…", "user": { "id", "name", "email", "phone" } }`.
- Errors: `400/401` invalid credentials, `409` conflict message, `429` throttled.
- PC timeout: 25s per attempt.

### `POST /api/auth/device` (browser sign-in, Clerk-ready)
- Start: `{ "action": "start" }` →
  `{ "device_code": "<64 hex>", "user_code": "…", "verify_url": "…", "expires_in": 600 }`.
  The PC opens `verify_url` in the system browser.
- Poll: `{ "action": "token", "device_code": "…" }` →
  `{ "status": "pending" }` |
  `{ "status": "approved", "auth_kind": "clerk", "session_token": "…", "refresh_token": "…", "expires_in": 3600, "user": { "id", "name?", "email?", "phone?" } }` |
  `{ "status": "approved", "custom_token": "…" }` (legacy Firebase) |
  `{ "status": "denied" }` | `{ "status": "expired" }`.
- The PC polls every 3s for up to 10.5 min; each poll times out at 25s.

### `POST /api/auth/clerk/refresh` (new, Clerk family only)
- Body: `{ "refresh_token": "…" }`.
- Success: `{ "session_token": "…", "refresh_token?": "…", "expires_in?": 3600 }`.
- Unknown/expired token → `401` (PC signs the user out cleanly).

### `GET /api/desktop-sync` · `PUT /api/desktop-sync`
Per-user settings/chat snapshot (last-write-wins).
- Auth: Bearer session token. Pull → `{ "blob": object | null, "updatedAt": string | null }`.
- Push body: `{ "blob": object (≤512 KB), "schemaVersion?": 1 }` → `200`.
- Signed-out PC never calls these. PC timeout: 30s each way.

## Versioning rule

Additive changes only (new optional fields, new endpoints). Never rename
fields, never change `pending/approved/denied/expired` strings, never
require new headers — older PC builds in the wild parse exactly this page.
