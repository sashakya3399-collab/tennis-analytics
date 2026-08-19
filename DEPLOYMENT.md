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
4. **Groq** (console.groq.com) — free API key, no card.
5. **Tavily** (tavily.com) — free API key, no card, 1000 credits/month.
6. **OpenWeatherMap** — free API key (activation can take up to ~2 hours after signup).

## Environment variables (Netlify → Project configuration → Environment variables)

```
GROQ_API_KEY=
GROQ_MODEL=groq/compound
GROQ_TEXT_MODEL=openai/gpt-oss-120b
TAVILY_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
OPENWEATHER_API_KEY=
CRON_SECRET=            # any long random string, e.g. `openssl rand -hex 32`
```

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
   invocations both draw from the same pool. Iterate cheaply: reproduce the exact
   Tavily→Groq→Supabase call chain locally with `curl`/`python3` (real keys are in
   `.env.local`) BEFORE pushing a fix, instead of deploy-and-see. Only push once a local
   reproduction confirms the fix.

## Groq gotchas

- Free tier caps `groq/compound` at **30,000 tokens/minute** (org-wide) on its internal routing
  model. This app's own system prompt alone is ~13,000 tokens — a single match analysis call
  requests ~14-18K tokens, leaving little headroom for back-to-back calls. The daily loop
  spaces match analyses 40 seconds apart for this reason (see `ARCHITECTURE.md`).
- `groq/compound`'s **built-in web search tool is currently broken** (`413 Request Entity Too
  Large` on most search-triggering prompts — a known, reported Groq platform issue, not
  something fixable on this end). This app does its own search via Tavily instead and tells the
  model not to search itself; the API client auto-retries the rare cases where Compound tries
  anyway.
- Check exact model availability for a given API key with `ListModels`
  (`GET https://api.groq.com/openai/v1/models`) — don't assume a model name from documentation
  is actually enabled/quota'd for a specific key.

## Local verification workflow (do this before every push, not after)

```bash
cd ~/Alish/tennis-analytics
pnpm exec tsc --noEmit && pnpm run build && pnpm run lint

# reproduce a real API call chain directly, e.g. Tavily search:
source .env.local
curl -s -X POST "https://api.tavily.com/search" \
  -H "content-type: application/json" -H "authorization: Bearer $TAVILY_API_KEY" \
  -d '{"query":"...", "search_depth":"basic", "max_results":3}'

# or a real Groq call:
curl -s -X POST "https://api.groq.com/openai/v1/chat/completions" \
  -H "Authorization: Bearer $GROQ_API_KEY" -H "content-type: application/json" \
  -d '{"model":"groq/compound","messages":[{"role":"user","content":"..."}]}'
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
