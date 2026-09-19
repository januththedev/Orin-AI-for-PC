# OmniRoute on the Orin AI backend (orinai.org) — integration spec (v1)

Your keys live on the **server**, users log in with their Orin AI account,
and every signed-in desktop request flows through this router. The desktop
already speaks the contract below — implement this file's three pieces on
orinai.org (not in this repo) and routing starts working with **zero PC
changes**.

```
Orin Code (signed in, Bearer session_token)
  │  POST {api_base}/api/chat  { mode, model, prompt, history }
  ▼
orinai.org /api/chat ── ① verify session ── ② plan/quota gate ── ③ ROUTER
  │        ┌──────────────┼───────────────────┐
  ▼        ▼              ▼                   ▼
OpenAI   Anthropic   DeepSeek/Groq/…   OpenRouter (many keys)
 key1..N  key1..N      key1..N           key1..N  ← YOUR pool
  │ auto-failover on 429 / 5xx / timeout / bad content, per-key cooldown
  ▼
{ text }  (desktop renders it as one ai-chunk; 401/429 surface as-is)
```

## 1. Desktop contract (frozen — do not change field names)

- Request: `POST /api/chat`, `Authorization: Bearer <session_token>`,
  JSON `{ "mode": "chat", "model": "orin-pro" | "orin-flash",
  "prompt": "<latest user turn>", "history": [{ "role", "content" }] }`.
- Success: `{ "text": "<full answer>" }` (non-streaming; desktop emits it
  as a single chunk).
- Errors the desktop already handles: `401` → "sign in again";
  `429` → "plan limit, resets daily"; other → `Orin AI error {status}`.
- Agent runs reuse this same endpoint per iteration (tool approvals,
  diffs, trajectory stay client-side), so the router sees plain chat
  turns and needs no tool awareness.

## 2. Key pool config (your manyyy keys)

Numbered env vars per provider (Vercel-friendly) — the router collects
`OPENROUTER_1 … OPENROUTER_20` in order and round-robins healthy keys with
per-key cooldown on failure. Adding, rotating, or removing a key is a redeploy
with zero code changes. A legacy comma-separated var is still accepted as a
fallback (`OPENROUTER_KEYS=sk-or-...,sk-or-...`).

```bash
OPENROUTER_1=sk-or-...
OPENROUTER_2=sk-or-...
OPENROUTER_3=sk-or-...
OPENROUTER_4=sk-or-...
OPENROUTER_5=sk-or-...
OPENROUTER_6=sk-or-...
# …add OPENROUTER_7 etc. whenever you want — no code change needed
ANTHROPIC_1=sk-ant-...
OPENAI_1=sk-...
DEEPSEEK_1=sk-...
# (same _1.._20 pattern for GROQ_, GEMINI_, XAI_, MISTRAL_, COHERE_,
#  PERPLEXITY_, TOGETHER_, FIREWORKS_)
```

One router serves **both** frontends: the website chatbot and the PC app
call the same `/api/chat` (or import `route()` from `lib/omniroute.ts`
directly) — same key pool, same failover, same quota metering.

Never log keys. Health state lives in memory (per server instance):
`{ failures, cooledUntil }` per key.

## 3. Tier → chain mapping (edit to taste)

```ts
const CHAINS: Record<string, Hop[]> = {
  "orin-flash": [ // fast + cheap first
    { provider: "groq", model: "llama-3.3-70b-versatile" },
    { provider: "gemini", model: "gemini-2.0-flash" },
    { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" },
    { provider: "openai", model: "gpt-4.1-mini" },
  ],
  "orin-pro": [ // strongest first
    { provider: "anthropic", model: "claude-sonnet-4-5" },
    { provider: "openai", model: "gpt-4.1" },
    { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
    { provider: "deepseek", model: "deepseek-chat" },
  ],
};
```

Unknown `model` values fall back to the `orin-pro` chain (desktop also
defaults to pro, so nothing silently downgrades). Hops whose pool is empty
are skipped automatically.

> OpenRouter-only setup (your case): keep the chains as-is but point every
> hop at `openrouter` with different model ids — e.g. `orin-pro` →
> `anthropic/claude-sonnet-4`, then `openai/gpt-4.1`, then
> `deepseek/deepseek-chat`, then a `:free` model as last resort. All 6
> `OPENROUTER_*` keys are tried per hop before moving on, so one key
> hitting a limit never stops an answer.

## 4. Paste-ready router — `lib/omniroute.ts` (Next.js, no new deps)

```ts
// lib/omniroute.ts — owner key pool + auto-failover. Node 18+ fetch only.
type Hop = { provider: string; model: string };
type Attempt = { ok: boolean; text?: string; retryable?: boolean };

const COOLDOWN_MS = 60_000;
const TIMEOUT_MS = 60_000;
const health = new Map<string, number>(); // key -> cooledUntil timestamp

function pool(prefix: string, legacy?: string): string[] {
  // Numbered vars first: OPENROUTER_1 … OPENROUTER_20 (Vercel-friendly).
  const numbered: string[] = []
  for (let i = 1; i <= 20; i++) {
    const key = (process.env[`${prefix}_${i}`] ?? "").trim()
    if (key) numbered.push(key)
  }
  if (numbered.length > 0) return numbered;
  // Fallback: legacy comma-separated var, e.g. OPENROUTER_KEYS.
  if (legacy) return (process.env[legacy] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return [];
}
const BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
  cohere: "https://api.cohere.ai/compatibility/v1",
  perplexity: "https://api.perplexity.ai",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
};
const ENVKEY: Record<string, [prefix: string, legacy: string]> = {
  openai: ["OPENAI", "OPENAI_KEYS"],
  anthropic: ["ANTHROPIC", "ANTHROPIC_KEYS"],
  deepseek: ["DEEPSEEK", "DEEPSEEK_KEYS"],
  groq: ["GROQ", "GROQ_KEYS"],
  xai: ["XAI", "XAI_KEYS"],
  mistral: ["MISTRAL", "MISTRAL_KEYS"],
  gemini: ["GEMINI", "GEMINI_KEYS"],
  openrouter: ["OPENROUTER", "OPENROUTER_KEYS"],
  cohere: ["COHERE", "COHERE_KEYS"],
  perplexity: ["PERPLEXITY", "PERPLEXITY_KEYS"],
  together: ["TOGETHER", "TOGETHER_KEYS"],
  fireworks: ["FIREWORKS", "FIREWORKS_KEYS"],
};

async function tryOpenAICompat(hop: Hop, key: string, messages: any[]): Promise<Attempt> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json", "Authorization": `Bearer ${key}`,
    };
    if (hop.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://orinai.org";
      headers["X-Title"] = "Orin AI Cloud";
    }
    const res = await fetch(`${BASE[hop.provider]}/chat/completions`, {
      method: "POST", headers, signal: ctrl.signal,
      body: JSON.stringify({ model: hop.model, stream: false, messages }),
    });
    if (res.status === 429 || res.status >= 500) return { ok: false, retryable: true };
    if (!res.ok) return { ok: false, retryable: false };
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content ?? "";
    if (!text) return { ok: false, retryable: true };
    return { ok: true, text };
  } catch { return { ok: false, retryable: true }; }
  finally { clearTimeout(t); }
}

async function tryAnthropic(hop: Hop, key: string, system: string, messages: any[]): Promise<Attempt> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json", "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: hop.model, max_tokens: 8192, system, messages }),
    });
    if (res.status === 429 || res.status >= 500) return { ok: false, retryable: true };
    if (!res.ok) return { ok: false, retryable: false };
    const json = await res.json();
    const text = (json.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    if (!text) return { ok: false, retryable: true };
    return { ok: true, text };
  } catch { return { ok: false, retryable: true }; }
  finally { clearTimeout(t); }
}

export async function route(
  chain: Hop[],
  args: { system: string; messages: { role: string; content: string }[] },
  onAttempt?: (info: { provider: string; model: string; keyLast4: string; ok: boolean }) => void,
): Promise<string> {
  const errors: string[] = [];
  for (const hop of chain) {
    const [prefix, legacy] = ENVKEY[hop.provider] ?? [hop.provider.toUpperCase(), ""];
    const keys = pool(prefix, legacy).filter(k => (health.get(k) ?? 0) < Date.now());
    for (const key of keys) {
      const attempt = hop.provider === "anthropic"
        ? await tryAnthropic(hop, key, args.system, args.messages)
        : await tryOpenAICompat(hop, key, args.messages);
      onAttempt?.({ provider: hop.provider, model: hop.model, keyLast4: key.slice(-4), ok: attempt.ok });
      if (attempt.ok) return attempt.text!;
      if (attempt.retryable) {
        health.set(key, Date.now() + COOLDOWN_MS); // cool this key, try next
        errors.push(`${hop.provider}/${hop.model}: retryable`);
      } else {
        errors.push(`${hop.provider}/${hop.model}: non-retryable`);
        break; // wrong model/auth for this hop — don't burn its other keys
      }
    }
  }
  throw new Error(`All providers failed: ${errors.join("; ")}`);
}
```

## 5. Paste-ready endpoint — `app/api/chat/route.ts`

```ts
// app/api/chat/route.ts
import { auth, clerkClient } from "@clerk/nextjs/server";
import { route } from "@/lib/omniroute";
import { CHAINS } from "@/lib/chains"; // §3 above
import { checkQuota, recordUsage } from "@/lib/quota"; // your plan logic

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "signed-out" }, { status: 401 });
  const { mode, model, prompt, history } = await req.json();
  if (!prompt) return Response.json({ error: "empty prompt" }, { status: 400 });

  const gate = await checkQuota(userId); // your per-plan daily limit
  if (!gate.allowed) return Response.json({ error: "plan limit" }, { status: 429 });

  const messages = [...(history ?? []), { role: "user", content: prompt }];
  try {
    const text = await route(CHAINS[model] ?? CHAINS["orin-pro"], { system: "", messages });
    await recordUsage(userId, model, prompt.length, text.length);
    return Response.json({ text });
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 502 });
  }
}
```

Password/legacy Firebase sessions: resolve the same plan row by your
existing uid mapping — the router never sees auth families, only the quota
decision.

## 6. What "automatically routed when something happens" means here

Reference implementation: `api/_lib/omni.js` in the website repo (this
doc's §4 sketch was its draft — the live file is authoritative).

- 429/5xx/timeout/empty → cool the key 60s, try the NEXT KEY on the same model.
- 401/403 (bad key) → quarantine that key for the rest of the request and
  keep going with the other keys — one dead key never blocks the next model.
- 400/404 (bad/unknown model) → skip straight to the NEXT MODEL in the tier.
- Every key cooling down → one last-resort pass ignoring cooldowns instead
  of failing instantly.
- Total failure → `502` with the failure trail (`model: reason` per hop);
  desktop shows `Orin AI error 502 …` (nothing crashes, chat history intact).
- Your plan gate stays **before** the router, so user quota is enforced
  once per request, not per attempt.

## 7. Later upgrades (no desktop breakage)

- Streaming: desktop `orin_cloud` is non-streaming today; keep `{ text }`
  until you ship SSE, then extend both sides together.
- Per-user keys: allow users to attach their own key server-side; check
  that pool before the owner pool in `route()`.
- `recordUsage` is the single place to meter cost per provider for billing.
