# Deployment runbook

Everything below reflects the real, live-tested setup as of 2026-08-19 (accounts:
`sashakya3399@gmail.com` / GitHub `sashakya3399-collab`). Consolidated from the actual
troubleshooting session — see `git log` for the exact commit-by-commit fix history.

## Accounts needed

1. **GitHub** — a repo (this one). Must be **public**, or Netlify's free plan needs upgrading —
   see "Netlify gotchas" below.
2. **Netlify** — a team + a site connected to the GitHub repo via continuous deployment.
3. **Supabase** — a project. Run `supabase/schema.sql` once in the SQL Editor. Create at least
   one Auth user manually (Authentication → Users → Add user) — there's no self-serve signup.
4. **Gemini API** (aistudio.google.com) — API key on a project with the Prepay minimum ($10)
   spent, so paid-tier billing is active (free tier hit zero-quota/deprecated-model dead ends on
   2026-08-19). See `GEMINI_PRICING_NOTES.md`.
5. **OpenWeatherMap** — free API key (activation can take up to ~2 hours after signup).

## Environment variables (Netlify → Project configuration → Environment variables)

```
GEMINI_API_KEY=
GEMINI_MODEL_FLASH=gemini-3.6-flash        # optional, this is the code default
GEMINI_MODEL_PRO=gemini-3.1-pro-preview    # optional, this is the code default
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
OPENWEATHER_API_KEY=
CRON_SECRET=            # any long random string, e.g. `openssl rand -hex 32`
```

**Note on which Netlify account**: this project deploys under a founder-dedicated account
(`sashakya3399@gmail.com`), which may not be the account any given machine's `netlify` CLI is
logged into — run `netlify status` and check the team/user name before trying to use the CLI to
set these; if it doesn't match, add them via the Netlify web dashboard instead (Site configuration
→ Environment variables), not the CLI.

`URL` (the site's own address) is injected by Netlify automatically at runtime — don't set it
manually. Changing any of the above requires a redeploy to take effect (Trigger deploy, or push
a commit).

## Netlify gotchas (each one cost real debugging time — don't re-derive these)

1. **New projects are private by default** (a 2026-07-28 Netlify platform change). This blocks
   more than external visitors — it also blocked this app's OWN internal server-to-server calls
   (the Scheduled Function / Server Actions calling the Background Function's own URL), which
   showed up as a confusing `401`. Fix: **Project configuration → General → Visitor access →
   Project visibility → Public.**
2. **Free plan blocks auto-deploy from an "unrecognized Git contributor"** on PRIVATE repos —
   and the free plan **cannot add team members at all** ("Upgrade to add members"), so there's
   no way to whitelist a second contributor for free. The only real fix on free: make the GitHub
   repo **public**. Making it public does NOT immediately fix a site that was already connected
   while private — Netlify caches the old "private" state; you must **disconnect and reconnect
   the repository** (Project configuration → Build & deploy → Manage repository → unlink, then
   re-add the site via Import from GitHub) for it to pick up the new public status.
3. **`middleware.ts` must exclude `.netlify/functions/*`** from its route matcher. Without this,
   the app's own auth middleware 307-redirects the Background Function's own URL to `/login`
   (no browser session on a server-to-server call), and since a 307 preserves the original HTTP
   method, the redirected request hits `/login` as a POST → `405 Method Not Allowed`. Already
   fixed in this repo's `middleware.ts`; don't remove the exclusion if you ever touch it.
4. **Credit-based free plan** (2026 pricing) — 300 credits/month, deploys and function
   invocations both draw from the same pool. Iterate cheaply: reproduce the exact Gemini call
   chain locally with a plain Node `fetch` script or `curl` (real key is in `.env.local`) BEFORE
   pushing a fix, instead of deploy-and-see. Only push once a local reproduction confirms the fix.

## Gemini gotchas

- **`googleSearch`/`codeExecution` tool use is prompt-shape-sensitive** — an "ONLY json, no
  prose" output instruction silently suppresses real search grounding; lead prompts with a short
  "Search the web right now for: X" imperative and ask for a trailing fenced json block instead.
  Full details: `~/.claude/skills/gemini-builtin-tool-invocation-prompt-shape/SKILL.md`.
- **Even with a good prompt, grounding is non-deterministic per call** (~60-70% in live testing,
  not 100%) — this app treats "didn't confirm grounding" as an escalation trigger to the Pro
  model rather than assuming a prompt fix alone is sufficient. See `ARCHITECTURE.md`.
- Check exact model availability for a given API key with `ListModels`
  (`GET https://generativelanguage.googleapis.com/v1beta/models?key=...`), then confirm with a
  real minimal `generateContent` call — don't assume a model name from documentation is actually
  enabled/quota'd for a specific key and billing tier.
- Prepay credit does not auto-reload — check `aistudio.google.com` → Billing before assuming the
  paid tier is still active.

## Local verification workflow (do this before every push, not after)

```bash
cd ~/Alish/tennis-analytics
pnpm exec tsc --noEmit && pnpm run build && pnpm run lint

# reproduce a real Gemini call directly:
source .env.local
curl -s -X POST "https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_FLASH}:generateContent?key=${GEMINI_API_KEY}" \
  -H "content-type: application/json" \
  -d '{"contents":[{"parts":[{"text":"..."}]}],"tools":[{"googleSearch":{}},{"codeExecution":{}}]}'
```

## Manual end-to-end test (once deployed)

```bash
source .env.local
curl -s -X POST "https://<site>.netlify.app/.netlify/functions/run-analysis-background" \
  -H "content-type: application/json" -H "authorization: Bearer $CRON_SECRET" \
  -d '{"mode":"manual_pre_match","playerA":"...","playerB":"...","surface":"Hard","location":"..."}'
# -> expect HTTP 202 immediately; the actual result lands in Supabase a bit later
```

Then poll Supabase directly (`manual_analyses` / `manual_analysis_entries` via the REST API with
the service-role key) rather than repeatedly reloading the dashboard, to watch for `last_error`
without spending a browser session.
