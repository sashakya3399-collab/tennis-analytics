# Tennis Analytics — Architecture

Screenshot-driven SET-1 total-games (over/under) analysis using the founder's 116-rule "Tennis
Quant Matrix Engine" spec, scoped down (2026-08-19 pivot) to a single deliverable: how many games
will be played in SET 1, over/under the line shown on an uploaded bookmaker screenshot. No win
probability, no predicted match score, no set 2/3. Password-protected dashboard, shareable link.
Runs entirely on free-tier services — no paid API required.

## Stack

- **Next.js 16** (App Router, `src/`, TypeScript, Tailwind v4)
- **Supabase** (Postgres + Auth) — no self-serve signup; accounts created manually in the
  Supabase dashboard (Authentication → Users → Add user)
- **Netlify** (hosting + Background Functions)
- **Groq** (console.groq.com, free, no card) — `groq/compound` for real server-side Python code
  execution + reasoning; `qwen/qwen3.6-27b` for reading the uploaded screenshot (vision)
- **Tavily** (tavily.com, free, 1000 req/month, no card) — real web search

## Provider history (for context — see `GEMINI_PRICING_NOTES.md` for the full story)

Built on Gemini → moved to Groq+Tavily (free) → moved back to native Gemini after the founder
spent real money to unlock paid-tier billing → moved BACK to Groq+Tavily the same day, after
discovering Gemini's own search-grounding tool bills retrieved page content as input tokens
(~$0.40/call observed) and the $10 credit ran out within an afternoon of testing, with no more
budget available. This is now the stable, zero-cost architecture.

## Scope pivot 2026-08-19: screenshot-only input, SET 1 total only

Founder-directed change:
- **Input**: no text form — the only input is an uploaded screenshot (typically a bookmaker's
  odds page). A vision-capable model (`qwen/qwen3.6-27b`) reads players, surface, tournament, and
  the total-games-1st-set line(s)/diapason directly from the image.
- **Output**: ONLY the SET 1 total-games over/under call (addendum section 081) — win probability,
  predicted match score, 3rd-set probability, and set 2/3 analysis are explicitly out of scope.
  The full real statistical pipeline (Elo/Bayesian shrinkage/serve-return/effective hold/Markov
  chain) still runs in full — it's just not carried past SET 1.
- **Line selection vs. probability computation** (addendum section 082): the diapason read from
  the screenshot selects WHICH total-games line to evaluate (clamped to [6.5, 12.5]) — it is
  explicitly NOT a probability input. The base spec's own rule ("never use bookmaker odds/
  market-implied probabilities as mathematical input") applies in full.
- **Required search factors** (addendum section 077): weather, court conditions, and each
  player's current state — fitness, fatigue, situational pressure/tension, injuries.
- **No daily automation**: every analysis is triggered by a screenshot upload, not a cron job.
- **LIVE update** (addendum section 078): same "reference the prior PRE-MATCH report, recompute
  from the current score" logic, scoped to SET 1 volume.

## Three-step pipeline (all free tier, no paid API)

1. **Vision extraction** (`qwen/qwen3.6-27b`, Groq free tier: 30 RPM / 1000 RPD) — reads the
   screenshot, returns a plain-text summary of players/surface/tournament/total-line diapason.
   Confirmed live: correctly read both players, surface, tournament, and both odds lines from a
   test screenshot in ~2.7s.
2. **Real web search** (Tavily, free: 1000 req/month) — 3 parallel searches: recent form/ranking/
   H2H, surface/serve/return stats + elevation, and weather/court/player-fatigue-injury news
   (`topic: "news"` for freshness). Confirmed live: returns real, curated results.
3. **Full Matrix Engine analysis** (`groq/compound`, Groq free tier: 30 RPM / 250 RPD) — the
   116-rule spec + founder addendum as system prompt, extraction + search results injected as
   context, explicit "you do not have a working search tool" instruction (compound's own built-in
   search returns a reproducible 413 on search-triggering prompts — confirmed, not fixed upstream),
   real code execution for the SET 1 statistical pipeline. This exact call shape (system prompt +
   compound + code execution) was previously confirmed working live earlier in this project.

No hybrid escalation (Flash→Pro) — Groq's free tier is a single tier; `escalatedToPro` is always
`false` in the result shape, kept only so the DB/UI code didn't need reshaping again mid-pivot.

## Known constraint: Groq's free tier shares one 30K-tokens/minute budget org-wide

`groq/compound`'s internal routing model (`meta-llama/llama-4-scout-17b-16e-instruct`) is capped
at 30,000 tokens/minute for the whole organization, and one analysis call alone requests
~13-18K tokens (system prompt dominates). Confirmed live 2026-08-19: rapid back-to-back test calls
hit this ceiling repeatedly, with `Used` climbing even between attempts — there may be real
concurrent usage on this org outside this app's own testing (worth checking the Groq console's own
usage dashboard if this recurs in production). `callGroq()` in `src/lib/groq/client.ts` retries
automatically on 429, honoring the server's suggested delay (see below) — this is expected to
clear naturally for a single real user upload (not a rapid test burst).

## Data flow

```
Browser (screenshot upload, ManualAnalysisForm)
  └─> Server Action (analyzeScreenshotAction) — converts File to base64, fires the Background
      Function and returns {started: true} immediately (does NOT await the analysis)
        └─> POST /.netlify/functions/run-analysis-background (fire-and-forget, gets 202 immediately)
              └─> Background Function (run-analysis-background.ts, 15-min budget)
                    ├─ mode: screenshot_pre_match
                    │   analyzeScreenshot(image):
                    │     1. extractFromScreenshot() — qwen/qwen3.6-27b vision call
                    │     2. 3× Tavily search (form/H2H, serve/return stats, weather/injuries)
                    │     3. generateMatchAnalysis() — groq/compound, full spec + context,
                    │        code execution, SET 1 total over/under
                    │   → parse trailing ```json``` block → create manual_analyses + entries rows
                    ├─ mode: manual_live — same analysis step, referencing the prior PRE-MATCH
                    │   report + a typed-in live score (no image, no re-extraction)
                    └─ self-reports failures onto manual_analyses.last_error
```

A Server Action can't do this work synchronously — Netlify caps those at 10s (free) / 26s (paid),
and the 3-call chain (vision + 3 searches + compound analysis) routinely takes 30-90+ seconds.

## Database (see `supabase/schema.sql`; existing projects: see the dated migration file)

- `manual_analyses` — one row per player pair a screenshot was uploaded for; `player_a`/`player_b`
  are extracted from the screenshot, not user-typed. `last_error` surfaces failures.
- `manual_analysis_entries` — one row per PRE-MATCH build or LIVE recompute; `surface`/
  `court_or_tournament` also model-extracted; numeric columns are all SET-1-scoped
  (`expected_games_a/b`, `total_games_line`, `total_over/under_probability`, etc.); `model_used`
  and `used_search_grounding` stored per-entry.

Confidence/volatility are numeric 0-10 (the spec's own convention).

## Known issues / operating constraints (as of 2026-08-19)

1. **Groq's 30K TPM org-wide free-tier ceiling** — see above.
2. **`groq/compound`'s built-in search tool can still fire despite instructions** — the client
   automatically retries on `413` (up to 2 attempts) since this is non-deterministic per call.
3. **Image payload size**: the screenshot travels as base64 inside the Background Function's POST
   body — capped at 5MB original file size (`MAX_IMAGE_BYTES` in
   `src/app/actions/manual-analysis.ts`) as a defensive margin, not a measured ceiling.
4. **Vision + code execution are separate Groq calls/models** — `qwen/qwen3.6-27b` (vision, no
   confirmed hosted code execution) and `groq/compound` (code execution, no confirmed reliable
   vision) were not combined in one call; not verified whether a single-call combo exists on Groq.
5. **Netlify credit-based free plan** (2026 pricing) — 300 credits/month, deploys and function
   invocations share the pool. Iterate by verifying fixes directly against the real Groq/Tavily
   APIs locally (plain Node `fetch`/`curl`) before pushing.

## Repo layout notes

- `src/lib/groq/` — the LLM client (`client.ts`, plain `fetch`, no SDK) + the 116-rule spec,
  embedded as a TS module (`system-prompt.ts`, generated from `system-prompt.txt` — regenerate via
  the inline python snippet in git history if the spec changes)
- `src/lib/search/tavily.ts` — real web search, truncates results (400 chars/snippet) to stay
  within Groq's token budget
- All imports inside `src/lib/**` use RELATIVE paths, not the `@/` tsconfig alias — Netlify's
  own esbuild function bundler (used for `netlify/functions/*`) doesn't resolve tsconfig path
  aliases, only the Next.js app's own bundler does
