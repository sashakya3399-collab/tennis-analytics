import { createAdminClient } from "../supabase/admin";
import { analyzeMatch, analyzeLiveUpdate, summaryToColumns } from "./match";
import { getWeatherForLocation } from "../weather/openweather";

export type ManualMatchInput = {
  playerA: string;
  playerB: string;
  surface?: string | null;
  tournament?: string | null;
  location?: string | null;
};

/**
 * Addendum section 077 — "PLAYER_1 / PLAYER_2 / SURFACE, immediately run
 * PRE-MATCH, no questions asked." Ad-hoc counterpart to runDailyAnalysis:
 * not tied to the auto-discovered daily schedule, triggered directly from
 * the dashboard form for any pair the founder wants to look up right now.
 *
 * Runs fire-and-forget from a Netlify Background Function (see
 * netlify/functions/run-analysis-background.ts) — there's no caller left
 * to hand a thrown error to by the time Groq responds, so failures are
 * caught here and written onto the row as `last_error` instead of thrown,
 * matching how runDailyAnalysis self-reports onto analysis_runs.
 */
export async function runManualPreMatch(input: ManualMatchInput): Promise<{ manualAnalysisId: string }> {
  const supabase = createAdminClient();

  const { data: parent, error: parentError } = await supabase
    .from("manual_analyses")
    .insert({
      player_a: input.playerA,
      player_b: input.playerB,
      surface: input.surface ?? null,
      tournament: input.tournament ?? null,
      location: input.location ?? null,
    })
    .select("id")
    .single();

  if (parentError || !parent) {
    throw new Error(`Failed to create manual_analyses row: ${parentError?.message}`);
  }

  try {
    const weather = input.location ? await getWeatherForLocation(input.location) : null;

    const analysis = await analyzeMatch(
      {
        tournament: input.tournament ?? "unspecified",
        round: null,
        surface: input.surface ?? null,
        location: input.location ?? null,
        player_a: input.playerA,
        player_b: input.playerB,
        scheduled_time: null,
      },
      weather,
    );

    const { error: entryError } = await supabase.from("manual_analysis_entries").insert({
      manual_analysis_id: parent.id,
      kind: "pre_match",
      live_score: null,
      ...summaryToColumns(analysis.summary),
      full_report: analysis.fullReport,
      model_used: process.env.GROQ_MODEL || "groq/compound",
      used_code_execution: analysis.usedCodeExecution,
      used_search_grounding: analysis.usedSearchGrounding,
    });

    if (entryError) {
      throw new Error(`Failed to create manual_analysis_entries row: ${entryError.message}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from("manual_analyses").update({ last_error: message }).eq("id", parent.id);
    throw err;
  }

  return { manualAnalysisId: parent.id };
}

/**
 * Addendum section 078 — LIVE recompute against an existing PRE-MATCH
 * entry for this pair, referencing rather than rebuilding the pre-match
 * groundwork. Same self-contained error handling as above.
 */
export async function runManualLiveUpdate(manualAnalysisId: string, liveScore: string): Promise<void> {
  const supabase = createAdminClient();

  try {
    const { data: parent, error: parentError } = await supabase
      .from("manual_analyses")
      .select("*")
      .eq("id", manualAnalysisId)
      .single();

    if (parentError || !parent) {
      throw new Error(`manual_analyses row not found: ${parentError?.message}`);
    }

    const { data: priorEntry, error: priorError } = await supabase
      .from("manual_analysis_entries")
      .select("full_report")
      .eq("manual_analysis_id", manualAnalysisId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (priorError || !priorEntry) {
      throw new Error("No prior analysis found for this pair — run a PRE-MATCH analysis first.");
    }

    const analysis = await analyzeLiveUpdate(
      {
        tournament: parent.tournament,
        round: null,
        surface: parent.surface,
        location: parent.location,
        playerA: parent.player_a,
        playerB: parent.player_b,
        priorFullReport: priorEntry.full_report,
      },
      liveScore,
    );

    const { error: entryError } = await supabase.from("manual_analysis_entries").insert({
      manual_analysis_id: manualAnalysisId,
      kind: "live",
      live_score: liveScore,
      ...summaryToColumns(analysis.summary),
      full_report: analysis.fullReport,
      model_used: process.env.GROQ_MODEL || "groq/compound",
      used_code_execution: analysis.usedCodeExecution,
      used_search_grounding: analysis.usedSearchGrounding,
    });

    if (entryError) {
      throw new Error(`Failed to create live manual_analysis_entries row: ${entryError.message}`);
    }

    await supabase.from("manual_analyses").update({ last_error: null }).eq("id", manualAnalysisId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from("manual_analyses").update({ last_error: message }).eq("id", manualAnalysisId);
    throw err;
  }
}
