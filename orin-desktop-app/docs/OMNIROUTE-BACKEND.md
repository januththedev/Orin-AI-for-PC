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

One env var per provider, comma-separated for multiple keys. The router
round-robins healthy keys and cools down failures — adding a key is a
redeploy with zero code changes:

```bash
OPENAI_KEYS=sk-...,sk-...
ANTHROPIC_KEYS=sk-ant-...,sk-ant-...
DEEPSEEK_KEYS=sk-...,sk-...
OPENROUTER_KEYS=sk-or-...,sk-or-...
GROQ_KEYS=gsk_...,gsk_...
GEMINI_KEYS=AIza...,AIza...
XAI_KEYS=xai-...,xai-...
MISTRAL_KEYS=...,-cohere/perplexity/together/fireworks likewise
```

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
defaults to pro, so nothing silently downgrades).

## 4. Paste-ready router — `lib/omniroute.ts` (Next.js, no new deps)

```ts
// lib/omniroute.ts — owner key pool + auto-failover. Node 18+ fetch only.
type Hop = { provider: string; model: string };
type Attempt = { ok: boolean; text?: string; retryable?: boolean };

const COOLDOWN_MS = 60_000;
const TIMEOUT_MS = 60_000;
const health = new Map<string, number>(); // key -> cooledUntil timestamp

function pool(name: string): string[] {
  return (process.env[name] ?? "").split(",").map(s => s.trim()).filter(Boolean);
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
const ENVKEY: Record<string, string> = {
  openai: "OPENAI_KEYS", anthropic: "ANTHROPIC_KEYS", deepseek: "DEEPSEEK_KEYS",
  groq: "GROQ_KEYS", xai: "XAI_KEYS", mistral: "MISTRAL_KEYS",
  gemini: "GEMINI_KEYS", openrouter: "OPENROUTER_KEYS", cohere: "COHERE_KEYS",
  perplexity: "PERPLEXITY_KEYS", together: "TOGETHER_KEYS", fireworks: "FIREWORKS_KEYS",
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
    const keys = pool(ENVKEY[hop.provider] ?? "").filter(k => (health.get(k) ?? 0) < Date.now());
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

- 429/5xx/timeout/empty → next key, same provider → next provider hop.
- Bad auth or unknown model → skip remaining keys of that hop (don't burn
  good keys on a config error), continue down the chain.
- Total failure → `502` with the failure trail; desktop shows
  `Orin AI error 502 …` (nothing crashes, chat history intact).
- Your plan gate stays **before** the router, so user quota is enforced
  once per request, not per attempt.

## 7. Later upgrades (no desktop breakage)

- Streaming: desktop `orin_cloud` is non-streaming today; keep `{ text }`
  until you ship SSE, then extend both sides together.
- Per-user keys: allow users to attach their own key server-side; check
  that pool before the owner pool in `route()`.
- `recordUsage` is the single place to meter cost per provider for billing.
