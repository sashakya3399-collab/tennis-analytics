"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { triggerBackgroundAnalysis } from "@/lib/analysis/trigger";

export type ManualActionState = { error?: string; started?: boolean } | null;

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * Both actions below only fire the Background Function and return — see
 * trigger.ts for why (Gemini calls with search + code execution routinely exceed
 * Netlify's 10s/26s Server Action timeout). The result appears on the
 * dashboard a bit later; there's no live "here's your analysis" response.
 */

export async function createManualAnalysis(
  _prev: ManualActionState,
  formData: FormData,
): Promise<ManualActionState> {
  const user = await requireUser();
  if (!user) return { error: "Требуется вход в систему." };

  const playerA = String(formData.get("player_a") ?? "").trim();
  const playerB = String(formData.get("player_b") ?? "").trim();
  if (!playerA || !playerB) return { error: "Укажите обоих игроков." };

  try {
    await triggerBackgroundAnalysis({
      mode: "manual_pre_match",
      playerA,
      playerB,
      surface: String(formData.get("surface") ?? "").trim() || null,
      tournament: String(formData.get("tournament") ?? "").trim() || null,
      location: String(formData.get("location") ?? "").trim() || null,
    });
    return { started: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

export async function addLiveUpdate(
  _prev: ManualActionState,
  formData: FormData,
): Promise<ManualActionState> {
  const user = await requireUser();
  if (!user) return { error: "Требуется вход в систему." };

  const manualAnalysisId = String(formData.get("manual_analysis_id") ?? "");
  const liveScore = String(formData.get("live_score") ?? "").trim();
  if (!manualAnalysisId || !liveScore) return { error: "Укажите текущий счёт." };

  try {
    await triggerBackgroundAnalysis({ mode: "manual_live", manualAnalysisId, liveScore });
    return { started: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

/** Removes a manual analysis pair (and its entries, via FK cascade) — dashboard cleanup. */
export async function deleteManualAnalysis(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!user) return;

  const manualAnalysisId = String(formData.get("manual_analysis_id") ?? "");
  if (!manualAnalysisId) return;

  const supabase = createAdminClient();
  await supabase.from("manual_analyses").delete().eq("id", manualAnalysisId);
  revalidatePath("/");
}
