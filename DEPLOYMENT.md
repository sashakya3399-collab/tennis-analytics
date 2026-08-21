# Deployment runbook

Everything below reflects the real, live-tested setup as of 2026-08-19 (accounts:
`sashakya3399@gmail.com` / GitHub `sashakya3399-collab`). Consolidated from the actual
troubleshooting session — see `git log` for the exact commit-by-commit fix history.

## Accounts needed

1. **GitHub** — a repo (this one). Must be **public**, or Netlify's free plan needs upgrading —
   see "Netlify gotchas" below.
2. **Netlify** — a team + a site connected to the GitHub repo via continuous deployment.
3. **Supabase** — a project. Run `supabase/schema.sql` once in the SQL Editor (fresh project), or
   in order on an existing project: `supabase/migration_2026-08-19_first_set_total_screenshot.sql`
   then `supabase/migration_2026-08-21_processing_status_guard.sql`. Create at least one Auth user
   manually (Authentication → Users → Add user) — there's no self-serve signup.
4. **Groq** (console.groq.com) — free API key, no card.
5. **Tavily** (tavily.com) — free API key, no card, 1000 credits/month.

OpenWeatherMap and Gemini are no longer used (both removed 2026-08-19 — see
`GEMINI_PRICING_NOTES.md` for why Gemini was dropped). Weather is now one of the things Tavily
search looks up as part of the SET-1 analysis, not a separate pre-fetch API.

## Environment variables (Netlify → Project configuration → Environment variables)

```
GROQ_API_KEY=
GROQ_MODEL=groq/compound              # optional, this is the code default
GROQ_VISION_MODEL=qwen/qwen3.6-27b    # optional, this is the code default
TAVILY_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
CRON_SECRET=            # any long random string, e.g. `openssl rand -hex 32`
```

`OPENWEATHER_API_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL_FLASH`, `GEMINI_MODEL_PRO` can be removed
from Netlify's environment variables — no longer read by any code path.

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
   invocations both draw from the same pool. Iterate cheaply: reproduce the exact Groq/Tavily call
   chain locally with a plain Node `fetch` script or `curl` (real keys are in `.env.local`) BEFORE
   pushing a fix, instead of deploy-and-see. Only push once a local reproduction confirms the fix.

## Groq gotchas

- **Free tier caps `groq/compound` at 30,000 tokens/minute (org-wide)** on its internal routing
  model (`meta-llama/llama-4-scout-17b-16e-instruct`) — a SEPARATE, tighter budget than the
  headline `x-ratelimit-limit-tokens: 70000` you'll see on the outer `compound` response headers.
  This app's own system prompt alone is ~13,000 tokens — a single analysis call requests ~14-18K
  tokens, i.e. **over half the 30K budget on one call**. `callGroq()` in `src/lib/groq/client.ts`
  retries automatically on 429, honoring the server's suggested delay — don't rapid-fire manual
  test calls while debugging a rate-limit issue, that keeps the window from ever clearing
  (confirmed live 2026-08-19: `Used` kept climbing between repeated test attempts rather than
  resetting).
- **A single request already eating over half the budget means TWO overlapping requests can never
  both succeed, and nothing in the UI originally prevented that.** Confirmed live 2026-08-21: three
  real screenshot submissions across 6 minutes all failed with `Used` pinned at ~27-28K/30K the
  whole time — root cause was the founder (reasonably) submitting a second screenshot while the
  first was still deep in its own retry chain (each can legitimately run several minutes), not
  sustained external load. Fixed via `manual_analyses.status` (`processing`/`done`/`error`,
  migration `2026-08-21`) — a placeholder row is created SYNCHRONOUSLY before the Groq chain
  starts, and `analyzeScreenshotAction` rejects a new submission while one is already
  `processing`. See project memory `[[skill_background_job_overlap_guard_shared_rate_limit]]` for
  the generalized pattern. **Don't just raise `MAX_RETRIES` to fix a 429 you can't otherwise
  explain** — a longer retry chain widens this exact collision window rather than closing it.
- **`groq/compound`'s built-in web search tool is broken** (`413 Request Entity Too Large` on
  most search-triggering prompts — a known, reported Groq platform issue). This app does its own
  search via Tavily instead and tells the model not to search itself; the client auto-retries the
  rare cases where Compound tries anyway.
- **Vision (`qwen/qwen3.6-27b`) and code execution (`groq/compound`) are separate models/calls** —
  not confirmed whether a single Groq call can do both; this app keeps them as two sequential
  calls with independent free-tier quotas (30 RPM/1000 RPD vs. 30 RPM/250 RPD).
- Check exact model availability for a given API key with `ListModels`
  (`GET https://api.groq.com/openai/v1/models`) — don't assume a model name from documentation
  is actually enabled/quota'd for a specific key.

## Local verification workflow (do this before every push, not after)

```bash
cd ~/Alish/tennis-analytics
pnpm exec tsc --noEmit && pnpm run build && pnpm run lint

# reproduce a real Tavily search:
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

Screenshot upload is easiest tested through the actual dashboard UI (file input → submit). To test
the Background Function directly instead (bypassing the UI), base64-encode a real screenshot file
first:

```bash
source .env.local
# Create the placeholder row first (2026-08-21+: the background function expects
# an existing manual_analyses row id, it no longer inserts one itself) —
# either via the dashboard UI, or directly:
MANUAL_ID=$(curl -s -X POST "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/manual_analyses" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "content-type: application/json" -H "prefer: return=representation" \
  -d '{"player_a":"Обработка...","player_b":"Обработка...","status":"processing"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")

IMG_B64=$(base64 -i /path/to/screenshot.png)
curl -s -X POST "https://<site>.netlify.app/.netlify/functions/run-analysis-background" \
  -H "content-type: application/json" -H "authorization: Bearer $CRON_SECRET" \
  -d "{\"mode\":\"screenshot_pre_match\",\"manualAnalysisId\":\"$MANUAL_ID\",\"imageBase64\":\"$IMG_B64\",\"mimeType\":\"image/png\"}"
# -> expect HTTP 202 immediately; the actual result lands in Supabase a bit later
```

Then poll Supabase directly (`manual_analyses` / `manual_analysis_entries` via the REST API with
the service-role key) rather than repeatedly reloading the dashboard, to watch `status` go from
`processing` to `done`/`error` without spending a browser session. **Check `status` before firing a
manual test this way** — if a real `processing` row already exists (from the founder's own UI
session), a second concurrent call will collide with it exactly as described in the Groq gotchas
section above; either wait for it to resolve or delete the stale row first.
