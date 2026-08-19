import { z } from "zod";
import { generateMatchAnalysis, extractTrailingJsonBlock } from "../gemini/client";
import type { WeatherSnapshot } from "../weather/openweather";
import type { ScheduledMatch } from "./schedule";

/**
 * Shared result shape for both PRE-MATCH and LIVE analyses — mirrors the
 * "МАТЕМАТИЧЕСКИЙ ИТОГ" compact block (system-prompt.txt section 075) plus
 * the O/U and altitude/weather additions layered on top of the base spec.
 * confidence/volatility are numeric 0-10 to match the spec's own X/10
 * convention everywhere (061 PRE FINAL DASHBOARD and 075 both use X/10 —
 * an earlier low/medium/high bucket was a deviation, corrected here).
 */
const AnalysisSummarySchema = z.object({
  win_probability_a: z.number().min(0).max(1).nullable().optional(),
  win_probability_b: z.number().min(0).max(1).nullable().optional(),
  predicted_score: z.string().nullable().optional(),
  third_set_probability: z.number().min(0).max(1).nullable().optional(),
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
  ranking_a: z.string().nullable().optional(),
  ranking_b: z.string().nullable().optional(),
  surface_weather_note: z.string().nullable().optional(),
  motivation_note: z.string().nullable().optional(),
  main_model_scenario: z.string().nullable().optional(),
  main_uncertainty: z.string().nullable().optional(),
});

export type AnalysisSummary = z.infer<typeof AnalysisSummarySchema>;

export type MatchAnalysisResult = {
  fullReport: string;
  summary: AnalysisSummary | null;
  usedCodeExecution: boolean;
  usedSearchGrounding: boolean;
};

const TRAILING_JSON_SHAPE = `{
  "win_probability_a": 0.0-1.0 or null,
  "win_probability_b": 0.0-1.0 or null,
  "predicted_score": "e.g. P1 2:1",
  "third_set_probability": 0.0-1.0 or null,
  "expected_games_a": number or null,
  "expected_games_b": number or null,
  "expected_total_games": number or null,
  "main_corridor": "e.g. 21-24",
  "confidence": 0-10 or null,
  "data_coverage_pct": number or null,
  "volatility": 0-10 or null,
  "model_conflict": true | false,
  "total_games_line": number or null,
  "total_over_probability": 0.0-1.0 or null,
  "total_under_probability": 0.0-1.0 or null,
  "ranking_a": "e.g. ATP #12" or null,
  "ranking_b": "e.g. ATP #34" or null,
  "surface_weather_note": "short string, e.g. compound last-10 record in matching conditions" or null,
  "motivation_note": "short string on any stakes/motivation asymmetry, or explicitly 'no material asymmetry'" or null,
  "main_model_scenario": "short string",
  "main_uncertainty": "short string"
}`;

function weatherLine(weather: WeatherSnapshot | null): string {
  if (!weather) return "Weather: not available for this location.";
  const parts = [
    weather.condition,
    weather.temp_c != null ? `${weather.temp_c}°C (feels like ${weather.feels_like_c}°C)` : null,
    weather.humidity_pct != null ? `${weather.humidity_pct}% humidity` : null,
    weather.wind_mps != null ? `${weather.wind_mps} m/s wind` : null,
  ].filter(Boolean);
  return `Weather at ${weather.location}: ${parts.join(", ")}.`;
}

function parseSummary(fullText: string): AnalysisSummary | null {
  const rawSummary = extractTrailingJsonBlock(fullText);
  const parsed = rawSummary ? AnalysisSummarySchema.safeParse(rawSummary) : null;
  return parsed?.success ? parsed.data : null;
}

/**
 * Maps a parsed summary onto the DB column shape shared by match_analyses
 * and manual_analysis_entries (same schema — see supabase/schema.sql) so
 * the daily pipeline and the manual/live pipeline don't duplicate this.
 */
export function summaryToColumns(summary: AnalysisSummary | null) {
  return {
    win_probability_a: summary?.win_probability_a ?? null,
    win_probability_b: summary?.win_probability_b ?? null,
    predicted_score: summary?.predicted_score ?? null,
    third_set_probability: summary?.third_set_probability ?? null,
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
    ranking_a: summary?.ranking_a ?? null,
    ranking_b: summary?.ranking_b ?? null,
    surface_weather_note: summary?.surface_weather_note ?? null,
    motivation_note: summary?.motivation_note ?? null,
    key_factors: summary
      ? {
          model_conflict: summary.model_conflict,
          main_model_scenario: summary.main_model_scenario,
          main_uncertainty: summary.main_uncertainty,
        }
      : null,
  };
}

/**
 * Runs the full Matrix Engine (loaded as systemInstruction, including the
 * founder addendum — sections 075-080) against one specific match. The
 * prompt asks the model to follow the spec exactly — including the
 * mandated PRE FINAL DASHBOARD + МАТЕМАТИЧЕСКИЙ ИТОГ blocks in Russian —
 * plus explicit additions the founder asked for on top of the base spec
 * (total games O/U line, last-15 same-surface form, altitude/ball-bounce,
 * first-serve/return stats, hot/rain surface-slide history, a narrower
 * last-10 surface+weather-matched comparison, real current ranking, and
 * motivation/stakes asymmetry) — then append one trailing ```json block
 * with the fields we persist as queryable columns.
 */
export async function analyzeMatch(
  match: Pick<ScheduledMatch, "tournament" | "round" | "surface" | "location" | "player_a" | "player_b" | "scheduled_time">,
  weather: WeatherSnapshot | null,
): Promise<MatchAnalysisResult> {
  const prompt = `Apply the full Matrix Engine specification above to this real, current match.
Use Google Search grounding to find real, live, current data for both players (recent results,
head-to-head, surface stats, injuries, ranking) — do not fabricate any statistic. Use code
execution to actually run the Elo, Bayesian shrinkage, hold/break, and Markov-chain set/match
probability math the spec describes — do not eyeball or mentally approximate the numbers.

MATCH:
Tournament: ${match.tournament}
Round: ${match.round ?? "unknown"}
Surface: ${match.surface ?? "unknown"}
Location: ${match.location ?? "unknown"}
Scheduled time: ${match.scheduled_time ?? "unknown"}
Player A: ${match.player_a}
Player B: ${match.player_b}
${weatherLine(weather)}

ADDITIONAL REQUIRED FACTORS (on top of the base spec — these are mandatory for this build):

1. SURFACE + LAST 15 ON THIS SURFACE: the base spec's section 062 asks for a "Last-10-Surface"
   split — override that to LAST 15, not 10 (section 076 priority #4 in the addendum defers to
   this per-call instruction). Search for and report each player's last 15 completed matches
   specifically on ${match.surface ?? "this surface"} (win/loss record, and briefly how they
   played — dominant/close/struggling), not last 15 overall. If a player has fewer than 15 career
   matches on this surface, use however many real matches exist and say so explicitly rather than
   padding with off-surface matches.

2. TOTAL GAMES OVER/UNDER: in addition to the spec's EXPECTED GAMES / TOTAL DISTRIBUTION SUMMARY
   output, pick ONE standard bookmaker-style total-games line (nearest sensible half-integer to
   your computed expected total, e.g. 21.5, 22.5) and give an explicit Over/Under call: probability
   the total goes OVER that line and probability it goes UNDER it (they should sum to ~1.0). State
   the line and both probabilities as their own labeled output, not buried only in prose.

3. ALTITUDE / BALL PHYSICS: search for the host city's elevation above sea level. If the venue is
   at meaningfully high altitude (roughly >500m — e.g. Madrid ~667m is a known real example on
   tour), explicitly factor in the physical effect: thinner air reduces drag on the ball, which
   increases ball speed through the air and bounce height/skid — this generally favors bigger
   servers and flatter, faster hitters, and tends to push the total-games and ace-count expectation
   up. State the elevation in meters and whether/how it adjusts your read, even if the effect is
   negligible at low altitude — say so explicitly rather than omitting the factor.

4. FIRST SERVE % AND RETURN OF SERVE: search for each player's real, current first-serve-in
   percentage, first-serve points won %, second-serve points won %, and return points won %
   (recent tour-level form, not just career average) for their SERVE and RETURN ratings in the
   dashboard below — do not assign those 1-10 ratings without grounding them in these real stats.

5. WEATHER / SURFACE-SLIDE FACTOR: using the weather line above, explicitly reason about court
   conditions — hot and dry (faster, harder court, ball flies further), rain/high humidity (slower
   court, ball picks up less pace, and on clay a WET clay court gets noticeably more slippery,
   changing how reliably players can slide into shots), or windy (disrupts timing, favors flatter
   hitters over players who rely on heavy topspin arcs). Search for how each player has performed
   historically in these SAME conditions before (hot-weather matches, rain-affected/high-humidity
   matches, matches where sliding into the shot on a wet/slick surface mattered) — name which
   player has the better track record in this specific condition and why, rather than a generic
   "weather could be a factor" statement.

6. LAST 10 UNDER THIS EXACT SURFACE+WEATHER COMBINATION: separately from the broader LAST-15
   surface-only sample in item 1, isolate up to the LAST 10 matches for EACH player that most
   closely match TODAY'S specific combination of surface AND weather profile (hot/dry,
   rain/high-humidity, windy, or mild/neutral — whichever this match's weather line above falls
   into). From that narrower, condition-matched sample, compute an explicit comparative number for
   each player (e.g. win rate or games-won rate in that sample) and state directly which player
   mathematically performs better in this specific case — this must be a stated comparison, not
   just narrative. If real match-by-match weather-tagged history genuinely isn't available (public
   databases usually don't tag conditions), say so explicitly and fall back to the closest available
   proxy (e.g. surface-only last-10, or the item-1 last-15 sample), naming the fallback used.

7. RANKING + MOTIVATION/STAKES ASYMMETRY: search for and explicitly state each player's real,
   current ATP/WTA singles ranking (and ranking points if findable) — do not leave this implicit.
   Then reason about why THIS match matters to each player right now: ranking points being
   defended from last year at this same event, points needed to stay in/reach the top N for
   seeding or direct entry to majors, ATP/WTA Race-to-Finals implications, prize money significance
   at this round, and recent schedule load (deep runs the prior week vs. a bye/early exit/rest).
   If one player has already secured what they need this season (or is clearly using this as a
   low-stakes tune-up/return-from-injury match) while the other has a real, concrete reason to push
   hard, say so explicitly and adjust the win probability for it — do not default to assuming both
   players are equally motivated and giving 100% effort without checking.

Produce the full MANDATORY OUTPUT (section 061, PRE FINAL DASHBOARD) exactly as specified,
in Russian, incorporating all seven factors above inline (the LAST-15-surface split from item 1
replaces the spec's default LAST-10 language for the general surface sample; add explicit "ТОТАЛ
ГЕЙМОВ" over/under, "ВЫСОТА НАД УРОВНЕМ МОРЯ", "ПОГОДА / ПОКРЫТИЕ", "ПОСЛЕДНИЕ 10 (ПОКРЫТИЕ+ПОГОДА)",
"РЕЙТИНГ", and "МОТИВАЦИЯ" lines to the dashboard). Immediately after the PRE FINAL DASHBOARD, also
output the compact "🎾 МАТЕМАТИЧЕСКИЙ ИТОГ" block per addendum section 075.

After both blocks, append exactly one fenced block:
\`\`\`json
${TRAILING_JSON_SHAPE}
\`\`\``;

  const { fullText, usedCodeExecution, usedSearchGrounding } = await generateMatchAnalysis(prompt);

  return {
    fullReport: fullText,
    summary: parseSummary(fullText),
    usedCodeExecution,
    usedSearchGrounding,
  };
}

export type PriorAnalysisContext = {
  tournament?: string | null;
  round?: string | null;
  surface?: string | null;
  location?: string | null;
  playerA: string;
  playerB: string;
  priorFullReport: string;
};

/**
 * LIVE recompute — addendum section 078: when a PRE-MATCH analysis already
 * exists for this pair and a new live score comes in, don't repeat the
 * whole PRE-MATCH build-up, just recompute LIVE against the prior context.
 * The prior full report is passed back to the model as context (not
 * re-derived) so it can reference rather than redo the surface/serve/
 * return/hold groundwork.
 */
export async function analyzeLiveUpdate(
  context: PriorAnalysisContext,
  liveScore: string,
): Promise<MatchAnalysisResult> {
  const prompt = `LIVE UPDATE per addendum section 078 — a PRE-MATCH analysis for this exact pair
already exists (full text below). Do NOT redo the full PRE-MATCH build-up (surface/serve/return/
hold groundwork). Take the current live score as new evidence and recompute the LIVE win
probabilities, most likely final score, and total games from this point, using code execution for
the actual math (score-state game/set probability, not eyeballing).

MATCH:
Tournament: ${context.tournament ?? "unknown"}
Round: ${context.round ?? "unknown"}
Surface: ${context.surface ?? "unknown"}
Location: ${context.location ?? "unknown"}
Player A: ${context.playerA}
Player B: ${context.playerB}

CURRENT LIVE SCORE: ${liveScore}

PRIOR PRE-MATCH ANALYSIS (context only, do not repeat verbatim):
"""
${context.priorFullReport}
"""

Produce a COMPACT live update per addendum section 079 (compactness — do not repeat identical
conclusions across sections, no long intro): a short "LIVE" heading, what changed since the
pre-match read given the current score, then the "🎾 МАТЕМАТИЧЕСКИЙ ИТОГ" block (section 075)
recomputed for the live state, in Russian.

After that, append exactly one fenced block:
\`\`\`json
${TRAILING_JSON_SHAPE}
\`\`\``;

  const { fullText, usedCodeExecution, usedSearchGrounding } = await generateMatchAnalysis(prompt);

  return {
    fullReport: fullText,
    summary: parseSummary(fullText),
    usedCodeExecution,
    usedSearchGrounding,
  };
}
