# Orin Code ↔ orinai.org — Clerk bridge contract (v1)

The PC app (`552ce4c`+) signs in through the **browser device flow** and
accepts a Clerk approval with a **Firebase fallback**. No PC changes are
needed beyond this file's contract — implement the three server items below
in the orinai.org codebase (not in this repo) using the Clerk account's keys.

## 0. Clerk dashboard (5 min, no code)

1. Create an application → copy **Publishable key**
   (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`) and **Secret key** (`CLERK_SECRET_KEY`).
2. Allowed origins: `https://orinai.org` (+ preview domains).

## 1. Device verify page hosts Clerk sign-in

The PC app opens `verify_url` from `POST /api/auth/device { action: "start" }`
in the system browser. That page must:

- Render Clerk `<SignedOut><SignIn /></SignedOut>`.
- When `<SignedIn>`, call your existing link step with the Clerk identity:
  `POST /api/auth/device { action: "approve", device_code, clerk_user_id }`
  (verify the request with `auth()` from `@clerk/nextjs/server` — never trust
  a client-sent user id).

No PC change: `auth_device_start` / `auth_device_wait` keep polling the same
endpoint.

## 2. Device token approval — Clerk shape (new) or Firebase shape (legacy)

`POST /api/auth/device { action: "token", device_code }` while pending:

```json
{ "status": "pending" }
```

Once approved, return **one** of:

```json
// Clerk (preferred once §1 ships)
{
  "status": "approved",
  "auth_kind": "clerk",
  "session_token": "<opaque, min 32 bytes random>",
  "refresh_token": "<opaque, min 32 bytes random>",
  "expires_in": 3600,
  "user": { "id": "<clerk user id>", "name": "...", "email": "...", "phone": "" }
}
```

```json
// Firebase (legacy — PC still accepts it)
{ "status": "approved", "custom_token": "<firebase custom token>" }
```

Denied/expired stay `{ "status": "denied" }` / `{ "status": "expired" }`.

**Minting (Next.js sketch):**

```ts
import { auth, clerkClient } from "@clerk/nextjs/server";
import { randomBytes } from "crypto";

const { userId } = await auth();
if (!userId) return Response.json({ error: "signed-out" }, { status: 401 });
const user = await (await clerkClient()).users.getUser(userId);
// store: device_code -> { clerkUserId: userId, session_token, refresh_token, … }
// session_token = `orin_sess_${randomBytes(32).toString("hex")}`
```

Map the Clerk user to your plan/quota row by `userId` (stable across logins).

## 3. Refresh endpoint (new, Clerk only)

```ts
// POST /api/auth/clerk/refresh  { refresh_token }
// → { session_token, refresh_token?, expires_in? }
```

Rotate or reuse the opaque refresh token; 401 on unknown/expired so the PC
app signs the user out cleanly.

## 4. Chat + sync accept the session token

`GET /api/chat` (and `/api/desktop-sync`) already take a Bearer token via the
PC core's `ensure_id_token`. Accept the opaque `session_token` there and
resolve the plan/quota from its Clerk `userId` mapping — or, alternatively,
verify a Clerk session JWT with `CLERK_SECRET_KEY` per request. Either way,
**signed-in users get Orin Cloud models with no API keys**; signed-out users
degrade to local/BYOK mode (keys stay in the OS keyring, managed by the
embedded OmniRoute vault — workflow uninterrupted).

## PC behavior matrix (already shipped)

| Entry | Gate | After entering |
|---|---|---|
| Sign in with Orin AI | Device flow → Clerk (§1–§2) | Cloud models, no keys needed |
| Connect own API key | Any `keyRequired` preset key | Composer auto-points at first live model; more keys anytime in Settings → Models |
| Explore offline | Dismiss | Mock responder; sign in / add keys later in Settings → Account / Models |

`App.tsx` treats **any** stored provider key as "has entered" (plus the legacy
`openai_compat` slot), so new presets never re-trigger the welcome gate.
