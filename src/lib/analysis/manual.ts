import { createAdminClient } from "../supabase/admin";
import { analyzeScreenshot, analyzeLiveUpdate, summaryToColumns } from "./match";
import type { GroqImage } from "../groq/client";

/**
 * Creates the visible-immediately 'processing' placeholder row BEFORE the
 * Groq chain starts (2026-08-21) — two purposes: (1) the dashboard shows
 * something the instant a submission is accepted instead of nothing for
 * 30-90s, which was being read as "it didn't work"; (2)
 * analyzeScreenshotAction can check for an existing 'processing' row and
 * block a second submission for the same wait, since two overlapping runs
 * both compete for the same tight per-minute Groq quota (root cause of a
 * real, confirmed pile-up: 3 real attempts across 6 minutes all failing
 * with usage pinned near the ceiling, because each one's own retry chain
 * was still alive when the next was fired).
 */
export async function createProcessingPlaceholder(): Promise<{ manualAnalysisId: string }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("manual_analyses")
    .insert({ player_a: "Обработка...", player_b: "Обработка...", status: "processing" })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`Failed to create processing placeholder: ${error?.message}`);
  }
  return { manualAnalysisId: data.id };
}

/** True if a screenshot analysis is already running (unresolved 'processing' row). */
export async function hasProcessingAnalysis(): Promise<boolean> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("manual_analyses")
    .select("id")
    .eq("status", "processing")
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/**
 * Addendum section 077 (2026-08-19 pivot — screenshot-only input): runs the
 * 3-step vision-extraction → Tavily search → groq/compound analysis chain
 * against an already-created placeholder row (see
 * createProcessingPlaceholder above) and updates it IN PLACE with the real
 * result — never inserts a second row, so there's exactly one row per
 * submission from the moment it's accepted.
 *
 * Runs fire-and-forget from a Netlify Background Function (see
 * netlify/functions/run-analysis-background.ts) — there's no caller left
 * to hand a thrown error to by the time Groq responds, so failures are
 * caught here and written onto the same placeholder row.
 */
export async function runScreenshotAnalysis(manualAnalysisId: string, image: GroqImage): Promise<void> {
  const supabase = createAdminClient();

  try {
    const analysis = await analyzeScreenshot(image);

    const playerA = analysis.summary?.player_a?.trim() || "Игрок 1 (не распознан)";
    const playerB = analysis.summary?.player_b?.trim() || "Игрок 2 (не распознан)";

    const { error: updateError } = await supabase
      .from("manual_analyses")
      .update({ player_a: playerA, player_b: playerB, status: "done", last_error: null })
      .eq("id", manualAnalysisId);

    if (updateError) {
      throw new Error(`Failed to update manual_analyses row: ${updateError.message}`);
    }

    const { error: entryError } = await supabase.from("manual_analysis_entries").insert({
      manual_analysis_id: manualAnalysisId,
      kind: "pre_match",
      live_score: null,
      ...summaryToColumns(analysis.summary),
      full_report: analysis.fullReport,
      model_used: analysis.modelUsed,
      used_code_execution: analysis.usedCodeExecution,
      used_search_grounding: analysis.usedSearchGrounding,
    });

    if (entryError) {
      throw new Error(`Failed to create manual_analysis_entries row: ${entryError.message}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("manual_analyses")
      .update({ player_a: "Ошибка распознавания", player_b: "Ошибка распознавания", status: "error", last_error: message })
      .eq("id", manualAnalysisId);
  }
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
      .select("full_report, surface")
      .eq("manual_analysis_id", manualAnalysisId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (priorError || !priorEntry) {
      throw new Error("No prior analysis found for this pair — analyze a screenshot first.");
    }

    const analysis = await analyzeLiveUpdate(
      {
        playerA: parent.player_a,
        playerB: parent.player_b,
        surface: priorEntry.surface,
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
      model_used: analysis.modelUsed,
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
