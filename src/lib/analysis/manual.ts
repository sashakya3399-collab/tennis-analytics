import { createAdminClient } from "../supabase/admin";
import { analyzeScreenshot, analyzeLiveUpdate, summaryToColumns } from "./match";
import type { GroqImage } from "../groq/client";

/**
 * Addendum section 077 (2026-08-19 pivot — screenshot-only input): the
 * user uploads a screenshot; analyzeScreenshot() runs the 3-step
 * vision-extraction → Tavily search → groq/compound analysis chain and
 * returns everything (including the extracted player names) in one
 * result — there's no separate "create the row, then analyze" step since
 * we don't know the player names until the vision step has read the image.
 *
 * Runs fire-and-forget from a Netlify Background Function (see
 * netlify/functions/run-analysis-background.ts) — there's no caller left
 * to hand a thrown error to by the time Groq responds, so failures are
 * caught here. Since we don't have a row to attach last_error to until
 * AFTER the analysis (player names aren't known yet), a failure here
 * creates a row with placeholder player names so it's still visible on the
 * dashboard rather than silently vanishing.
 */
export async function runScreenshotAnalysis(image: GroqImage): Promise<{ manualAnalysisId: string }> {
  const supabase = createAdminClient();

  try {
    const analysis = await analyzeScreenshot(image);

    const playerA = analysis.summary?.player_a?.trim() || "Игрок 1 (не распознан)";
    const playerB = analysis.summary?.player_b?.trim() || "Игрок 2 (не распознан)";

    const { data: parent, error: parentError } = await supabase
      .from("manual_analyses")
      .insert({ player_a: playerA, player_b: playerB })
      .select("id")
      .single();

    if (parentError || !parent) {
      throw new Error(`Failed to create manual_analyses row: ${parentError?.message}`);
    }

    const { error: entryError } = await supabase.from("manual_analysis_entries").insert({
      manual_analysis_id: parent.id,
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

    return { manualAnalysisId: parent.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { data: failedRow } = await supabase
      .from("manual_analyses")
      .insert({
        player_a: "Ошибка распознавания",
        player_b: "Ошибка распознавания",
        last_error: message,
      })
      .select("id")
      .single();
    return { manualAnalysisId: failedRow?.id ?? "" };
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
