"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { triggerBackgroundAnalysis } from "@/lib/analysis/trigger";
import { createProcessingPlaceholder, hasProcessingAnalysis } from "@/lib/analysis/manual";

export type ManualActionState = { error?: string; started?: boolean } | null;

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

// Netlify Background Function invocations carry the image as base64 inside
// the JSON POST body — cap the ORIGINAL file well under typical Lambda-style
// payload ceilings (base64 adds ~33% overhead) rather than finding out via a
// mysterious 413/502 on a large screenshot.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Screenshot upload → fires the Background Function and returns — see
 * trigger.ts for why (the vision + search + code-execution chain routinely
 * exceeds Netlify's 10s/26s Server Action timeout). The result appears on
 * the dashboard a bit later; there's no live "here's your analysis"
 * response.
 */
export async function analyzeScreenshotAction(
  _prev: ManualActionState,
  formData: FormData,
): Promise<ManualActionState> {
  const user = await requireUser();
  if (!user) return { error: "Требуется вход в систему." };

  const file = formData.get("screenshot");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Выберите файл скриншота." };
  }
  if (!file.type.startsWith("image/")) {
    return { error: "Файл должен быть изображением (PNG/JPEG/WebP)." };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { error: `Файл слишком большой (макс. ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB).` };
  }

  // Two overlapping background runs both compete for the same tight
  // per-minute Groq quota on groq/compound's internal routing model —
  // confirmed live (2026-08-21) as the real cause behind a run failing even
  // with a generous retry budget. Block a second submission while one is
  // still in flight rather than let them collide.
  if (await hasProcessingAnalysis()) {
    return {
      error:
        "Анализ уже выполняется — дождитесь его завершения (обычно 30-90 секунд, иногда дольше " +
        "из-за лимита Groq) перед новой загрузкой.",
    };
  }

  try {
    const bytes = await file.arrayBuffer();
    const imageBase64 = Buffer.from(bytes).toString("base64");

    const { manualAnalysisId } = await createProcessingPlaceholder();

    await triggerBackgroundAnalysis({
      mode: "screenshot_pre_match",
      manualAnalysisId,
      imageBase64,
      mimeType: file.type,
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
