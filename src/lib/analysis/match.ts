import { z } from "zod";
import {
  extractFromScreenshot,
  generateMatchAnalysis,
  extractTrailingJsonBlock,
  type GroqImage,
} from "../groq/client";
import { searchWeb, formatSearchResults } from "../search/tavily";

/**
 * Result shape for both PRE-MATCH and LIVE analyses — mirrors the
 * "МАТЕМАТИЧЕСКИЙ ИТОГ — ТОТАЛ 1-ГО СЕТА" compact block (system-prompt.txt
 * section 075): SET 1 total games (over/under) ONLY — no win probability,
 * no predicted match score, no set 2/3 (addendum sections 081/082).
 */
const AnalysisSummarySchema = z.object({
  player_a: z.string().nullable().optional(),
  player_b: z.string().nullable().optional(),
  surface: z.string().nullable().optional(),
  court_or_tournament: z.string().nullable().optional(),
  expected_games_a: z.number().nullable().optional(),
  expected_games_b: z.number().nullable().optional(),
  expected_total_games: z.number().nullable().optional(),
  main_corridor: z.string().nullable().optional(),
  confidence: z.number().min(0).max(10).nullable().optional(),
  data_coverage_pct: z.number().nullable().optional(),
  volatility: z.number().min(0).max(10).nullable().optional(),
  model_conflict: z.boolean().nullable().optional(),
  total_games_line: z.number().nullable().optional(),
  total_over_probability: z.number().min(0).max(1).nullable().optional(),
  total_under_probability: z.number().min(0).max(1).nullable().optional(),
  weather_note: z.string().nullable().optional(),
  player_state_note: z.string().nullable().optional(),
  main_model_scenario: z.string().nullable().optional(),
  main_uncertainty: z.string().nullable().optional(),
});

export type AnalysisSummary = z.infer<typeof AnalysisSummarySchema>;

export type MatchAnalysisResult = {
  fullReport: string;
  summary: AnalysisSummary | null;
  usedCodeExecution: boolean;
  usedSearchGrounding: boolean;
  modelUsed: string;
  escalatedToPro: boolean; // always false — Groq's free tier has one tier, no hybrid escalation
};

const TRAILING_JSON_SHAPE = `{
  "player_a": "string, first player as extracted from the screenshot",
  "player_b": "string, second player as extracted from the screenshot",
  "surface": "e.g. Hard/Clay/Grass, or null if not readable",
  "court_or_tournament": "short string — tournament/venue if visible, or null",
  "expected_games_a": number or null (SET 1 only),
  "expected_games_b": number or null (SET 1 only),
  "expected_total_games": number or null (SET 1 only),
  "main_corridor": "e.g. 8-10 (SET 1 games range)",
  "confidence": 0-10 or null,
  "data_coverage_pct": number or null,
  "volatility": 0-10 or null,
  "model_conflict": true | false,
  "total_games_line": number or null (SET 1 total line, within 6.5-12.5, see addendum 082),
  "total_over_probability": 0.0-1.0 or null,
  "total_under_probability": 0.0-1.0 or null,
  "weather_note": "short string, real found facts about weather/court conditions" or null,
  "player_state_note": "short string, real found facts about either player's fitness/fatigue/tension/injuries" or null,
  "main_model_scenario": "short string",
  "main_uncertainty": "short string"
}`;

function parseSummary(fullText: string): AnalysisSummary | null {
  const rawSummary = extractTrailingJsonBlock(fullText);
  const parsed = rawSummary ? AnalysisSummarySchema.safeParse(rawSummary) : null;
  return parsed?.success ? parsed.data : null;
}

/**
 * Maps a parsed summary onto the DB column shape shared by
 * manual_analyses/manual_analysis_entries (see supabase/schema.sql).
 */
export function summaryToColumns(summary: AnalysisSummary | null) {
  return {
    surface: summary?.surface ?? null,
    court_or_tournament: summary?.court_or_tournament ?? null,
    expected_games_a: summary?.expected_games_a ?? null,
    expected_games_b: summary?.expected_games_b ?? null,
    expected_total_games: summary?.expected_total_games ?? null,
    main_corridor: summary?.main_corridor ?? null,
    confidence: summary?.confidence ?? null,
    data_coverage_pct: summary?.data_coverage_pct ?? null,
    volatility: summary?.volatility ?? null,
    total_games_line: summary?.total_games_line ?? null,
    total_over_probability: summary?.total_over_probability ?? null,
    total_under_probability: summary?.total_under_probability ?? null,
    weather_note: summary?.weather_note ?? null,
    player_state_note: summary?.player_state_note ?? null,
    key_factors: summary
      ? {
          model_conflict: summary.model_conflict,
          main_model_scenario: summary.main_model_scenario,
          main_uncertainty: summary.main_uncertainty,
        }
      : null,
  };
}

const EXTRACTION_PROMPT = `This image is a screenshot, typically a bookmaker's odds/lines page for a
tennis match. Read from it, as literally shown:

1. PLAYER_1 and PLAYER_2 (in the order they appear on screen)
2. SURFACE (Hard/Clay/Grass) if shown
3. Tournament/court/venue if shown
4. The total-games-1st-set line(s) and odds shown (e.g. "Over 9.5 @1.85 / Under 9.5 @1.95") — if
   more than one line is shown, list all of them

If something genuinely cannot be read, say so — do not guess or invent it.

Respond with a short plain-text summary of what you found (no JSON needed), e.g.:
"Players: X vs Y. Surface: Hard. Tournament: Cincinnati Open. Total 1st set lines: 9.5 (Over 1.85/
Under 1.95), 10.5 (Over 2.10/Under 1.70)."`;

/**
 * Extracts player/surface/diapason from the uploaded screenshot via a
 * vision-capable model (qwen/qwen3.6-27b on Groq — free tier, no card).
 * Kept as its own call, separate from the math analysis, since Groq's free
 * vision and free code-execution quotas are independent per-model limits.
 *
 * Strips a leading <think>...</think> block — qwen3.6-27b's reasoning
 * models emit one before the actual answer (confirmed live), and it's
 * verbose enough on its own to blow past Tavily's 1500-character query
 * limit if left in (confirmed live: a real "Query is too long" 400 from
 * embedding the raw extraction output, think-block included, into a
 * search query). Neither the search queries nor the final analysis prompt
 * need the model's internal reasoning, only its actual answer.
 */
async function extractMatchFacts(image: GroqImage): Promise<string> {
  const raw = await extractFromScreenshot(image, EXTRACTION_PROMPT);
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Tavily's hard limit is 1500 chars; stay well under it for the base query before appending topic keywords. */
const MAX_QUERY_FACTS_CHARS = 300;

/**
 * PRE-MATCH analysis, screenshot-only input (addendum section 077). Three
 * real steps, all on free-tier services (Groq + Tavily, no paid API):
 * 1. Vision extraction (qwen/qwen3.6-27b) — read players/surface/diapason
 *    off the screenshot.
 * 2. Real web search (Tavily) — recent form, surface/serve/return stats,
 *    weather, court conditions, and each player's fitness/fatigue/tension/
 *    injuries (per addendum 077's required factors).
 * 3. Full Matrix Engine analysis (groq/compound) — real code execution for
 *    the SET 1 statistical pipeline, scoped per addendum 081/082.
 *
 * Switched from a single-call Gemini vision+search+codeExec design
 * 2026-08-19 (same day) after the founder's Gemini Prepay credit ran out
 * faster than expected — Gemini's own search tool bills retrieved page
 * content as input tokens (~$0.40/call observed), while this three-step
 * design costs nothing (all free tiers) at a real cost of extra latency
 * (3 sequential calls instead of 1) and losing Gemini's single-call
 * elegance.
 */
export async function analyzeScreenshot(image: GroqImage): Promise<MatchAnalysisResult> {
  const extractedFacts = await extractMatchFacts(image);
  // Defensive cap on top of the <think>-stripping above — never let a
  // search query exceed Tavily's 1500-char limit regardless of how
  // verbose a future extraction-model response turns out to be.
  const queryFacts = extractedFacts.slice(0, MAX_QUERY_FACTS_CHARS);

  const [formSearch, statsSearch, weatherPlayerSearch] = await Promise.all([
    searchWeb(`${queryFacts} recent form ranking head-to-head tennis 2026`, 3),
    searchWeb(`${queryFacts} first serve percentage return stats court elevation`, 3),
    searchWeb(`${queryFacts} weather forecast court conditions player injury fatigue news`, 3, "news"),
  ]);
  const searchContext = [
    formatSearchResults("Screenshot extraction (players/surface/total lines)", { answer: extractedFacts, results: [] }),
    formatSearchResults("Ranking, recent form, head-to-head", formSearch),
    formatSearchResults("Surface/serve stats, host city elevation", statsSearch),
    formatSearchResults("Weather, court conditions, player fatigue/injury/pressure news", weatherPlayerSearch),
  ].join("\n\n---\n\n");

  const prompt = `${searchContext}

---

Apply the full Matrix Engine specification above to this real, current match, using ONLY the
real information above (screenshot extraction + search results) as your source of live facts —
do NOT attempt to search the web yourself under any circumstances (this call has no working
search tool; attempting to invoke one will fail the whole request). Where the information above
doesn't cover something, say so explicitly per the spec's own "не выдумывать данные" rule rather
than inventing a number. Use code execution to actually run the Elo, Bayesian shrinkage,
hold/break, and Markov-chain SET 1 game/set probability math the spec describes — do not eyeball
or mentally approximate the numbers.

SCOPE (mandatory, per addendum 081): compute and output ONLY the SET 1 total-games over/under
call. Do NOT compute or output match win probability, predicted match score, 3rd-set probability,
or any set 2/3 analysis — run the full real methodology, just stop at SET 1.

REQUIRED FACTORS (per addendum 077): explicitly reason about weather/court conditions and each
player's current state (fitness, fatigue, situational pressure/tension, injuries) using the search
results above — if the results don't cover one of these, say "нет данных" for it rather than
skipping it silently.

LINE SELECTION (per addendum 082): use the diapason found in the screenshot extraction above to
choose which total-games-1st-set line to evaluate (clamped to [6.5, 12.5]). Your OVER/UNDER
PROBABILITY for that line must be computed independently from the real SET 1 pipeline — never
inferred from or blended with the bookmaker's own odds/implied probability (base spec section 003's
rule against using bookmaker odds as mathematical input still applies in full).

Report your own confidence and volatility (0-10) honestly in the trailing JSON block.

REMINDER (this is not optional): you do not have a working web-search tool in this call. If
anything above is missing from the search results, write "нет данных" for that specific point and
continue — do NOT call a search tool to try to find it, that call will fail and abort your entire
response. Code execution is the only tool available and expected here.

Produce the "🎾 МАТЕМАТИЧЕСКИЙ ИТОГ — ТОТАЛ 1-ГО СЕТА" block exactly per addendum section 075, in
Russian. After it, append exactly one fenced block:
\`\`\`json
${TRAILING_JSON_SHAPE}
\`\`\``;

  const { fullText, usedCodeExecution } = await generateMatchAnalysis(prompt);
  const summary = parseSummary(fullText);
  const ourSearchHadResults =
    formSearch.results.length > 0 || statsSearch.results.length > 0 || weatherPlayerSearch.results.length > 0;

  return {
    fullReport: fullText,
    summary,
    usedCodeExecution,
    usedSearchGrounding: ourSearchHadResults,
    modelUsed: process.env.GROQ_MODEL || "groq/compound",
    escalatedToPro: false,
  };
}

export type PriorAnalysisContext = {
  playerA: string;
  playerB: string;
  surface?: string | null;
  priorFullReport: string;
};

/**
 * LIVE recompute — addendum section 078: same SET-1-total scope, no image
 * needed (the live score is typed in, not screenshotted) — references the
 * prior PRE-MATCH report rather than re-deriving it.
 */
export async function analyzeLiveUpdate(
  context: PriorAnalysisContext,
  liveScore: string,
): Promise<MatchAnalysisResult> {
  const prompt = `LIVE UPDATE per addendum section 078 — a PRE-MATCH analysis for this exact pair
already exists (full text below), scoped to SET 1 total games only (addendum 081). Do NOT redo the
full PRE-MATCH build-up (surface/serve/return/hold groundwork), and do NOT attempt to search the
web (this call has no working search tool; attempting to invoke one will fail the whole request) —
the prior analysis below already has the facts you need. Take the current live score as new
evidence and recompute the LIVE SET 1 total-games over/under from this point, using code execution
for the actual math (score-state game probability, not eyeballing).

MATCH:
Player A: ${context.playerA}
Player B: ${context.playerB}
Surface: ${context.surface ?? "unknown"}

CURRENT LIVE SCORE: ${liveScore}

PRIOR PRE-MATCH ANALYSIS (context only, do not repeat verbatim):
"""
${context.priorFullReport}
"""

SCOPE (mandatory, per addendum 081): still ONLY SET 1 total games over/under — no match win
probability, no predicted match score, no set 2/3, even if the live score shows the match has
progressed past set 1 (if set 1 has already concluded, recompute the FINAL set 1 total against
what actually happened, using code execution on the completed set 1 score).

Produce a COMPACT live update per addendum section 079 (compactness — do not repeat identical
conclusions across sections, no long intro): a short "LIVE" heading, what changed since the
pre-match read given the current score, then the "🎾 МАТЕМАТИЧЕСКИЙ ИТОГ — ТОТАЛ 1-ГО СЕТА" block
(section 075) recomputed for the live state, in Russian.

Report your own confidence and volatility (0-10) honestly in the trailing JSON block.

After that, append exactly one fenced block:
\`\`\`json
${TRAILING_JSON_SHAPE}
\`\`\``;

  const { fullText, usedCodeExecution } = await generateMatchAnalysis(prompt);

  return {
    fullReport: fullText,
    summary: parseSummary(fullText),
    usedCodeExecution,
    usedSearchGrounding: false,
    modelUsed: process.env.GROQ_MODEL || "groq/compound",
    escalatedToPro: false,
  };
}
