# Gemini pricing notes — LIVE architecture as of 2026-08-19

Real, live-fetched pricing from `ai.google.dev/gemini-api/docs/pricing`, captured the same day the
founder spent a real $10 on AI Studio's Prepay minimum to unlock paid-tier billing on
`project-6737c023-bc37-41f5-a67`. This app now runs on the hybrid described below, not Groq/Tavily.

## Models in use

- **`gemini-3.6-flash`** — default, every match runs on this first. GA (not preview).
  - Input: $0.75 / 1M tokens (through Dec 31, 2026; $1.50 from Jan 2027)
  - Output: $3.75 / 1M tokens (through Dec 31, 2026; $7.50 from Jan 2027)
- **`gemini-3.1-pro-preview`** — escalation only, when Flash's own output says a match is
  uncertain or didn't confirm real search grounding (see `ARCHITECTURE.md`). Preview status —
  could change without GA's notice period.
  - Input: $2.00 / 1M tokens (≤200k-token prompts; $4.00 above that)
  - Output: $12.00 / 1M tokens (≤200k-token prompts; $18.00 above that)
- **Google Search grounding**: 5,000 free requests/month shared across all Gemini 3.x models,
  then $14/1,000 requests. This app's realistic volume stays well under the free allowance.
- **Code execution**: no separate charge — billed at the selected model's standard token rates.

## Per-match cost (measured system-prompt size ~13,100 tokens, typical call shape ~17K in + 3K out)

- Flash only: ≈ **$0.024/match**
- Pro (escalated): ≈ **$0.07/match**

## Escalation rate — revised down from the founder's original "~20%" estimate

The founder originally reasoned "Flash by default + Pro on ~20% spory (contentious) matches."
Once implemented, a real finding changed that: Gemini's `googleSearch` tool doesn't reliably fire
even on a good prompt (~60-70% grounded in live A/B testing, not 100%) — "Flash didn't confirm it
searched" was folded into the escalation trigger alongside confidence/volatility. **Realistic
escalation rate is likely closer to 30-50%, not a fixed 20%** — it depends on how often real
matches are close AND how often Flash happens to skip searching, neither of which is a knob this
app controls precisely.

## Revised monthly cost estimate (blended, ~40% escalation as a working assumption)

Blended cost/match ≈ 0.6 × $0.024 + 0.4 × ($0.024 + $0.07) ≈ **$0.052/match**

- Quiet week (2-3 matches/day): ≈ **$4-5/month**
- Typical load (~10 matches/day): ≈ **$15-16/month**
- Heavy Grand Slam days: a few dollars extra, not a step-change

**At ~10 matches/day, the founder's $10 Prepay credit realistically lasts ~2-3 weeks**, not the
"3-4 weeks" estimated before the escalation-rate finding above. Check remaining balance at
`aistudio.google.com` → Billing before assuming the app can still call the paid tier — the credit
does not auto-reload (confirmed off during setup).

## If pricing/models change again

- Verify model availability LIVE for the actual API key first (`GET
  https://generativelanguage.googleapis.com/v1beta/models?key=...`, then a real minimal
  `generateContent` call) — `ListModels` showing a model doesn't guarantee it actually works for
  this key/tier.
- Re-fetch `ai.google.dev/gemini-api/docs/pricing` rather than trusting this file's numbers past
  Dec 31, 2026 (Flash pricing is explicitly time-boxed in Google's own docs).
