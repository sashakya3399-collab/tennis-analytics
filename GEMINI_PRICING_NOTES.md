# Gemini pricing notes — ARCHIVED (app no longer uses Gemini as of 2026-08-19)

**Status**: this app moved back to Groq + Tavily (free tier, no card) the same day these notes
were written, after the founder's $10 Gemini Prepay credit ran out faster than expected and no
further budget was available ("no extra money"). Kept as reference — the findings below are real
and could matter again if Gemini is ever revisited (e.g. the Vertex AI / $300 trial credit lead).

## What actually happened (real, live-observed 2026-08-19)

The $10 Prepay credit (real money, spent deliberately after confirming account-owner authorization)
was exhausted within one afternoon of development/testing — balance went to **-$1.48** (real total
spend ≈ $11.48), and a separate "Monthly spending limit (experimental): $10.24" was also hit.
Google's own "Total cost" dashboard graph significantly LAGGED the real, authoritative balance —
don't trust that graph for real-time cost tracking on this platform; trust the Credit Balance /
Transactions numbers instead.

## Root cause: search grounding bills retrieved page content as input tokens

Inspecting real `usageMetadata` on a grounded call revealed the actual cost driver the original
estimate missed entirely: when Gemini's `googleSearch` tool grounds, the RETRIEVED PAGE CONTENT
gets injected into context and billed under `toolUsePromptTokenCount` — one observed PRE-MATCH
call showed **438,500** such tokens (on top of a 16,370-token system+user prompt), costing
**≈$0.40 for that single call** — roughly 17x the original $0.024/match estimate, which only
counted the system prompt + typical output size.

## The fix that was chosen: don't use Gemini's own search tool at all

Rather than trying to constrain/reduce Gemini's search-grounding token usage, the app reverted to
the same real-search-as-a-separate-step pattern from earlier in this project's history: Tavily
(free, 1000 requests/month, curated short snippets, not full page text) for search, Groq
(`groq/compound`, free, 250 req/day) for reasoning + real code execution, and a Groq vision model
(`qwen/qwen3.6-27b`, free, 1000 req/day) for reading the uploaded screenshot. See `ARCHITECTURE.md`
for the current design.

## Unresolved research lead: Vertex AI / "Gemini Enterprise Agent Platform" + the untouched $300 credit

Real research (2026-08-19), not yet acted on: Vertex AI was rebranded to "Gemini Enterprise Agent
Platform" at Google Cloud Next 2026 — a DIFFERENT billing product from "Gemini API in AI Studio"
(the one that was actually used and ran out). Google's own docs explicitly exclude from the $300
free trial: (a) "Gemini API in AI Studio" specifically, and (b) third-party "partner" models sold
as "Model as a Service" (Claude, Llama, etc. via Model Garden) — but do NOT explicitly exclude
Google's own first-party Gemini models called via Vertex AI/Agent Platform's standard
`generateContent`-shaped API, which follows normal Google Cloud pay-as-you-go billing that the
$300 trial credit should cover. Multiple sources (including Google's own product pages) describe
the $300 credit as applying to this platform. **Not empirically confirmed** — would need a real
test call + checking Google Cloud Console billing to see whether it draws from the $300 trial
balance. Also requires different auth (OAuth2/service-account, not a simple API key) and a
different endpoint URL — real engineering work, not a config change. If ever revisited: verify
with ONE minimal real call before any re-architecture.

## Other researched options (for reference)

- **LiteLLM** ([github.com/BerriAI/litellm](https://github.com/BerriAI/litellm)) — open-source
  unified LLM gateway (Python), supports both Gemini-AI-Studio and Vertex AI backends with
  built-in cost tracking/caching. Requires running a separate Python service — likely overkill for
  this app's current scale, worth knowing about for a bigger future project.
- **Gemini implicit context caching** — already on by default for paid projects, gives ~90%
  discount on repeated content (the system prompt was already being partially cached, confirmed
  via `cachedContentTokenCount` in real responses) — this was NOT the cost problem; the
  search-grounding token injection was.

## Real per-token pricing at the time (for reference, may be stale by the time this is read again)

- `gemini-3.6-flash`: $0.75/1M input, $3.75/1M output (through Dec 31, 2026)
- `gemini-3.1-pro-preview`: $2.00/1M input (≤200k-token prompts; $4.00 above), $12.00/1M output
  (≤200k; $18.00 above)
- Google Search grounding: 5,000 free requests/month, then $14/1,000 requests (request COUNT
  wasn't the constraint — this app used only 55 of 1,500/day on the Gemini 3.x tier — token VOLUME
  per grounded request was)
