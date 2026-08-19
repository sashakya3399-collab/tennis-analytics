# Tennis Analytics — Architecture

Real, automated daily analysis of top-tier ATP/WTA matches using the founder's 116-rule
"Tennis Quant Matrix Engine" spec, replacing a manual iPhone-screenshots-into-Gemini-Gems
workflow. Password-protected dashboard, shareable link, meant to run unattended.

## Stack

- **Next.js 16** (App Router, `src/`, TypeScript, Tailwind v4)
- **Supabase** (Postgres + Auth) — no self-serve signup; accounts created manually in the
  Supabase dashboard (Authentication → Users → Add user)
- **Netlify** (hosting + Scheduled Functions + Background Functions)
- **Gemini API** (`gemini-3.6-flash` / `gemini-3.1-pro-preview`) — LLM inference with native
  Google Search grounding + real server-side Python code execution, both in the same call
- **OpenWeatherMap** — current conditions per match location

## Provider history (for context, not because it's still relevant to how the app runs)

Originally built on Gemini, moved to Groq+Tavily on 2026-08-19 after that day's free-tier Gemini
key hit dead ends (`gemini-2.5-pro`/`gemini-2.5-flash` deprecated, `gemini-3.1-pro-preview` at
zero free quota). Moved back to native Gemini the same day after the founder paid the real $10
Prepay minimum to unlock paid-tier billing — see `GEMINI_PRICING_NOTES.md` for the real,
live-fetched per-token pricing this decision was based on. Groq/Tavily code has been fully
removed, not kept as a fallback.

## Hybrid model selection (Flash → Pro escalation)

Every match runs on `gemini-3.6-flash` first (GA, ~$0.024/analysis). It escalates to
`gemini-3.1-pro-preview` (~$0.07/analysis, frontier reasoning) only when Flash's own output says
the call is uncertain — see `shouldEscalateToPro()` in `src/lib/analysis/match.ts`:

- `confidence <= 6/10` (Flash's own self-reported number)
- `volatility >= 7/10`
- `model_conflict === true`
- the trailing JSON block didn't parse at all
- **Flash didn't confirm real search grounding** (`candidate.groundingMetadata` absent) — added
  after a live finding, see below

This is a real threshold, not a forced quota — the actual escalation rate depends on how often
matches come out genuinely uncertain/ungrounded, not a fixed percentage.

## Known issue: Gemini's built-in search tool is prompt-shape-sensitive AND non-deterministic

Confirmed live via a controlled A/B test (2026-08-19): asking Gemini for "ONLY a raw JSON array,
no prose" made it skip calling `googleSearch` entirely and answer from training-data recall
instead, with `groundingMetadata` completely absent and no visible quality drop in the output.
Fixed by leading prompts with a short "Search the web right now for: X" imperative and asking for
a trailing fenced ```json block instead of an ONLY-json constraint (see
`src/lib/analysis/schedule.ts` and `match.ts` prompt construction). **Even with that fix, real
search grounding fires on roughly 60-70% of calls, not 100%** — this residual non-determinism is
why "didn't confirm grounding" is folded into the Flash→Pro escalation trigger above rather than
trusted to a prompt fix alone. Full writeup: `~/.claude/skills/gemini-builtin-tool-invocation-prompt-shape/SKILL.md`.

## Data flow

```
Scheduled Function (netlify/functions/daily-analysis.ts, cron 06:00 UTC)
  └─> POST /.netlify/functions/run-analysis-background  (fire-and-forget, gets 202 immediately)
        └─> Background Function (run-analysis-background.ts, 15-min budget)
              ├─ mode: daily
              │   ├─ single Gemini Flash call w/ googleSearch tool → fetchTodaysSchedule()
              │   │   (model searches + extracts structured JSON in one agentic call)
              │   ├─ filter to top-tier ATP/WTA singles only (isTopTierSinglesMatch)
              │   ├─ OpenWeatherMap per match location
              │   └─ per match (spaced 5s apart, conservative courtesy spacing — see
              │       run-daily-analysis.ts):
              │       analyzeMatch() → Flash call w/ googleSearch + codeExecution tools
              │       → if uncertain/ungrounded, re-run on Pro (see hybrid escalation above)
              │       → parse trailing ```json block → write to Supabase
              ├─ mode: manual_pre_match / manual_live — same analysis step, ad-hoc trigger
              └─ self-reports success/failure onto analysis_runs / manual_analyses.last_error
```

Server Actions (`rerunAnalysis`, `createManualAnalysis`, `addLiveUpdate`) only fire the
Background Function and return `{started: true}` immediately — they do NOT await the actual
analysis. This is required, not optional: Netlify caps synchronous functions/Server Actions at
10s (free) / 26s (paid), and a single Gemini call with search + code execution routinely takes
20-60+ seconds — a Pro escalation means two such calls back to back for one match.

## Database (see `supabase/schema.sql`)

- `analysis_runs` — one row per daily job (scheduled or manual), status/error self-reported
- `daily_schedule` — matches found that day (before analysis)
- `match_analyses` — one row per completed analysis, structured columns + full report text +
  `model_used` (which of Flash/Pro actually produced this result) + `used_search_grounding`
- `manual_analyses` / `manual_analysis_entries` — ad-hoc PLAYER_1/PLAYER_2/SURFACE lookups and
  their LIVE score updates; `last_error` on the parent row surfaces failures (writes happen
  fire-and-forget from a Background Function, so there's no synchronous caller to hand an error
  back to)

Confidence/volatility are numeric 0-10 (the spec's own convention), not a low/medium/high
bucket — an earlier design deviated from this and was corrected.

## Known issues / operating constraints (as of 2026-08-19)

1. **Search grounding non-determinism** — see the dedicated section above. `used_search_grounding`
   is stored per-analysis so ungrounded results are visible, not silently indistinguishable from
   verified ones.
2. **`gemini-3.1-pro-preview` is a Preview model**, not GA — could change or be deprecated without
   the same notice period as `gemini-3.6-flash`. If it ever breaks, the hybrid degrades to
   Flash-only (still functional, just without the escalation quality boost) until a replacement
   Pro-tier model is picked.
3. **Netlify credit-based free plan** (2026 pricing model) — deploys and function invocations
   both consume a shared monthly credit pool (300/month free). Iterate by verifying fixes
   directly against the real Gemini API locally (a plain Node script with `fetch`, bypassing
   Netlify entirely) before pushing, rather than deploy-and-see — see `DEPLOYMENT.md`.
4. **Prepay credit is not auto-reloading** — the founder's $10 credit will run out; check
   `aistudio.google.com` → Billing → payment before assuming the app is still able to call the
   paid tier.

## Repo layout notes

- `src/lib/gemini/` — the LLM client (`client.ts`, plain `fetch`, no SDK) + the 116-rule spec,
  embedded as a TS module (`system-prompt.ts`, generated from `system-prompt.txt` — regenerate
  via a one-off Node script if the spec changes; a raw Netlify function doesn't reliably ship
  loose static files)
- All imports inside `src/lib/**` use RELATIVE paths, not the `@/` tsconfig alias — Netlify's
  own esbuild function bundler (used for `netlify/functions/*`) doesn't resolve tsconfig path
  aliases, only the Next.js app's own bundler does
