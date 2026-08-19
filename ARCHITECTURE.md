# Tennis Analytics — Architecture

Real, automated daily analysis of top-tier ATP/WTA matches using the founder's 116-rule
"Tennis Quant Matrix Engine" spec, replacing a manual iPhone-screenshots-into-Gemini-Gems
workflow. Password-protected dashboard, shareable link, meant to run unattended.

## Stack

- **Next.js 16** (App Router, `src/`, TypeScript, Tailwind v4)
- **Supabase** (Postgres + Auth) — no self-serve signup; accounts created manually in the
  Supabase dashboard (Authentication → Users → Add user)
- **Netlify** (hosting + Scheduled Functions + Background Functions)
- **Groq** (`groq/compound`) — LLM inference with real server-side Python code execution
- **Tavily** — real web search (fed into prompts as context; see "Why not Gemini" below)
- **OpenWeatherMap** — current conditions per match location

## Why Groq + Tavily, not Gemini (as originally built)

The app was originally built on Gemini (`@google/genai`), which natively bundles Google Search
grounding + code execution in one API call. That was abandoned after live testing (2026-08-19)
showed the actual API key had: `gemini-2.5-pro` and `gemini-2.5-flash` both deprecated ("no
longer available to new users"), and `gemini-3.1-pro-preview` with **zero** free-tier quota
without a billing account attached. See `GEMINI_PRICING_NOTES.md` for what it would cost if you
ever want to switch back — realistically **$5-15/month** for this app's actual usage volume,
which is cheap; the tradeoff is money vs. the operational friction documented below.

Groq's free tier (`groq/compound`, 250 requests/day, no card) has real, confirmed-working code
execution, but its own **built-in web search tool is currently broken** — it returns a
reproducible `413 Request Entity Too Large` on nearly any search-triggering prompt, confirmed
independently on Groq's own community forum, worse specifically for non-English output (this
app's output is mandated Russian). So: real search now happens as its own step via Tavily,
BEFORE the Groq call, with results injected into the prompt as plain text context — the model is
explicitly told not to attempt to search itself.

## Data flow

```
Scheduled Function (netlify/functions/daily-analysis.ts, cron 06:00 UTC)
  └─> POST /.netlify/functions/run-analysis-background  (fire-and-forget, gets 202 immediately)
        └─> Background Function (run-analysis-background.ts, 15-min budget)
              ├─ mode: daily
              │   ├─ Tavily search ×2 (match pairings + tournament identity) → generateText()
              │   │   (plain, non-agentic openai/gpt-oss-120b — extracts structured JSON schedule)
              │   ├─ filter to top-tier ATP/WTA singles only (isTopTierSinglesMatch)
              │   ├─ OpenWeatherMap per match location
              │   └─ per match (spaced 40s apart, see "Known issues" below):
              │       Tavily search ×2 (player form/ranking/H2H; surface/serve/elevation)
              │       → groq/compound call (full spec as system message + search context
              │         + explicit "don't search, use code execution only" instructions)
              │       → parse trailing ```json block → write to Supabase
              ├─ mode: manual_pre_match / manual_live — same analysis step, ad-hoc trigger
              └─ self-reports success/failure onto analysis_runs / manual_analyses.last_error
```

Server Actions (`rerunAnalysis`, `createManualAnalysis`, `addLiveUpdate`) only fire the
Background Function and return `{started: true}` immediately — they do NOT await the actual
analysis. This is required, not optional: Netlify caps synchronous functions/Server Actions at
10s (free) / 26s (paid), and a single Groq call with code execution routinely takes 20-60+
seconds, with the full daily loop taking minutes.

## Database (see `supabase/schema.sql`)

- `analysis_runs` — one row per daily job (scheduled or manual), status/error self-reported
- `daily_schedule` — matches found that day (before analysis)
- `match_analyses` — one row per completed analysis, structured columns + full report text
- `manual_analyses` / `manual_analysis_entries` — ad-hoc PLAYER_1/PLAYER_2/SURFACE lookups and
  their LIVE score updates; `last_error` on the parent row surfaces failures (writes happen
  fire-and-forget from a Background Function, so there's no synchronous caller to hand an error
  back to)

Confidence/volatility are numeric 0-10 (the spec's own convention), not a low/medium/high
bucket — an earlier design deviated from this and was corrected.

## Known issues / operating constraints (as of 2026-08-19)

1. **Groq free tier: 30K tokens/minute cap** on `groq/compound`'s internal routing sub-model
   (`meta-llama/llama-4-scout`), org-wide. One match analysis call requests ~14-18K tokens (the
   ~13K-token system prompt dominates). Sequential match analyses are spaced 40s apart
   (`MATCH_ANALYSIS_SPACING_MS` in `run-daily-analysis.ts`) to stay under this; a busy day with
   many matches will make the daily job take several minutes, not seconds. If Groq's Dev/paid
   tier is ever added, this spacing can be removed.
2. **`groq/compound`'s built-in search tool bug can still fire despite instructions** — the
   client (`src/lib/groq/client.ts`) automatically retries on `413`/`429` (up to 2 attempts,
   honoring Groq's own suggested retry delay for 429s) since this is non-deterministic per call.
   Not 100% eliminated, just made resilient to.
3. **Netlify credit-based free plan** (2026 pricing model) — deploys and function invocations
   both consume a shared monthly credit pool (300/month free). Iterate by verifying fixes
   directly against the real Tavily/Groq APIs locally (curl/python, bypassing Netlify entirely)
   before pushing, rather than deploy-and-see — see `DEPLOYMENT.md`.
4. **`GEMINI_MODEL` availability is account-specific and changes without notice** — if ever
   switching back to Gemini, verify live via `ListModels` + a real `generateContent` probe call,
   not general documentation (confirmed unreliable for a fresh API key this session).

## Repo layout notes

- `src/lib/groq/` — the LLM client + the 116-rule spec, embedded as a TS module
  (`system-prompt.ts`, generated from `system-prompt.txt` — regenerate via a one-off Node script
  if the spec changes; a raw Netlify function doesn't reliably ship loose static files)
- `src/lib/search/tavily.ts` — real web search, truncates results (400 chars/snippet) to stay
  under the Groq token budget above
- All imports inside `src/lib/**` use RELATIVE paths, not the `@/` tsconfig alias — Netlify's
  own esbuild function bundler (used for `netlify/functions/*`) doesn't resolve tsconfig path
  aliases, only the Next.js app's own bundler does
