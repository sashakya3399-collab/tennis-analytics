# Gemini pricing notes (for reference only — app runs on Groq+Tavily, not Gemini)

Kept in case the founder wants to switch back for reliability (no free-tier friction) rather
than cost — captured 2026-08-19 from the official Gemini API pricing page.

## Recommended model if switching: `gemini-3.6-flash`

GA (not preview), described by Google as combining "frontier intelligence with superior search
and grounding." Cheaper than Pro-tier with no meaningful quality loss for this app, since the
actual math is done via code execution, not model "intelligence."

- Input: $0.75 / 1M tokens (through Dec 31, 2026; $1.50 from Jan 2027)
- Output: $3.75 / 1M tokens (through Dec 31, 2026; $7.50 from Jan 2027)
- Google Search grounding: 5,000 free requests/month (shared across Gemini 3.x models), then
  $14 / 1,000 requests

## Estimated monthly cost for this app's real usage

Based on measured system-prompt size (~13,100 tokens) and typical per-match call shape:

- ~17K input + ~3K output tokens per match analysis ≈ **$0.024/match**
- Search grounding: this app's realistic volume (a few to a couple dozen matches/day) stays
  well under the 5,000/month free grounding allowance — **effectively $0** grounding cost
- Quiet week (2-3 top-tier matches/day): **~$3/month**
- Typical load (~10 matches/day): **~$8/month**
- Heavy Grand Slam days: still just a few dollars extra, not a step-change

**Realistic range: $5-15/month.** Genuinely cheap — not a reason to avoid switching if the
Groq/Tavily operational friction (rate-limit spacing, the search-tool bug, retry logic) ever
becomes more trouble than it's worth. `gemini-2.5-pro` would cost roughly 2.5-3x more for the
same volume with no clear quality benefit for this specific task.

## If you do switch back

- Verify model availability LIVE for the actual API key first (`GET
  https://generativelanguage.googleapis.com/v1beta/models?key=...`) — `ListModels` showing a
  model doesn't mean `generateContent` will actually work for it; test with a real minimal call.
  This account's key had the entire Gemini 2.5 family deprecated and zero free quota on
  `gemini-3.1-pro-preview` despite general documentation suggesting otherwise.
- Gemini natively combines `googleSearch` + `codeExecution` in one call
  (`config.tools: [{googleSearch:{}}, {codeExecution:{}}]`) — this eliminates the whole
  Tavily-as-a-separate-step architecture and the associated prompt-size/rate-limit fights this
  app currently works around for Groq. See git history around 2026-08-19 for the original
  Gemini-based implementation if reverting.
