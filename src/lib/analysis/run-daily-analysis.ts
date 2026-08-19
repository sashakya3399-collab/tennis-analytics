import { createAdminClient } from "../supabase/admin";
import { fetchTodaysSchedule } from "./schedule";
import { analyzeMatch, summaryToColumns } from "./match";
import { getWeatherForLocation } from "../weather/openweather";

export type DailyRunResult = {
  runId: string;
  matchesFound: number;
  matchesAnalyzed: number;
  matchesFilteredOut: number;
  errors: string[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gemini's paid tier (activated 2026-08-19) has much higher per-minute
// limits than Groq's free tier did, so this is now just a conservative
// courtesy spacing rather than a load-bearing rate-limit workaround — the
// real safety net is callGemini()'s own 429 retry-with-backoff in
// src/lib/gemini/client.ts. The Background Function has a 15-minute
// budget, so this comfortably fits even a ~15-match day.
const MATCH_ANALYSIS_SPACING_MS = 5_000;

/**
 * The full daily job: find today's real schedule, fetch weather per match,
 * run the Matrix Engine analysis per match, persist everything. Designed to
 * be resilient — one match's failure doesn't stop the others, and partial
 * progress is still visible in the DB (run ends 'completed' with a lower
 * matches_analyzed count and per-error entries logged, not silently lost).
 */
export async function runDailyAnalysis(
  dateISO: string,
  trigger: "scheduled" | "manual" = "scheduled",
): Promise<DailyRunResult> {
  const supabase = createAdminClient();
  const errors: string[] = [];

  const { data: run, error: runError } = await supabase
    .from("analysis_runs")
    .insert({ run_date: dateISO, status: "running", trigger })
    .select("id")
    .single();

  if (runError || !run) {
    throw new Error(`Failed to create analysis_runs row: ${runError?.message}`);
  }
  const runId = run.id as string;

  let matchesAnalyzed = 0;
  let matchesFound = 0;
  let matchesFilteredOut = 0;

  try {
    const { matches: schedule, filteredOutCount } = await fetchTodaysSchedule(dateISO);
    matchesFound = schedule.length;
    matchesFilteredOut = filteredOutCount;

    for (const [index, match] of schedule.entries()) {
      if (index > 0) await sleep(MATCH_ANALYSIS_SPACING_MS);

      try {
        const weather = match.location ? await getWeatherForLocation(match.location) : null;

        const { data: scheduleRow, error: scheduleError } = await supabase
          .from("daily_schedule")
          .insert({
            run_id: runId,
            match_date: dateISO,
            tournament: match.tournament,
            tour_level: match.tour_level ?? null,
            round: match.round ?? null,
            surface: match.surface ?? null,
            location: match.location ?? null,
            player_a: match.player_a,
            player_b: match.player_b,
            scheduled_time: match.scheduled_time ?? null,
            weather: weather ?? null,
          })
          .select("id")
          .single();

        if (scheduleError || !scheduleRow) {
          throw new Error(`Failed to insert daily_schedule row: ${scheduleError?.message}`);
        }

        const analysis = await analyzeMatch(match, weather);

        const { error: analysisError } = await supabase.from("match_analyses").insert({
          schedule_id: scheduleRow.id,
          run_id: runId,
          player_a: match.player_a,
          player_b: match.player_b,
          ...summaryToColumns(analysis.summary),
          full_report: analysis.fullReport,
          model_used: analysis.modelUsed,
          used_code_execution: analysis.usedCodeExecution,
          used_search_grounding: analysis.usedSearchGrounding,
        });

        if (analysisError) {
          throw new Error(`Failed to insert match_analyses row: ${analysisError.message}`);
        }

        matchesAnalyzed += 1;
      } catch (matchErr) {
        const message = matchErr instanceof Error ? matchErr.message : String(matchErr);
        errors.push(`${match.player_a} vs ${match.player_b}: ${message}`);
      }
    }

    await supabase
      .from("analysis_runs")
      .update({
        status: "completed",
        matches_found: matchesFound,
        matches_analyzed: matchesAnalyzed,
        matches_filtered_out: matchesFilteredOut,
        error_message: errors.length ? errors.join(" | ") : null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
  } catch (fatalErr) {
    const message = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
    await supabase
      .from("analysis_runs")
      .update({
        status: "failed",
        matches_found: matchesFound,
        matches_analyzed: matchesAnalyzed,
        matches_filtered_out: matchesFilteredOut,
        error_message: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
    throw fatalErr;
  }

  return { runId, matchesFound, matchesAnalyzed, matchesFilteredOut, errors };
}
