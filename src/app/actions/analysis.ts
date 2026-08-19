"use server";

import { createClient } from "@/lib/supabase/server";
import { triggerBackgroundAnalysis } from "@/lib/analysis/trigger";

export type RerunState = { error?: string; started?: boolean } | null;

/**
 * Manual "re-run today's analysis" button — requires a logged-in session.
 * Fires the Background Function and returns immediately; the run itself
 * takes minutes (schedule discovery + one Gemini call per match), which is
 * why this doesn't await runDailyAnalysis directly — see trigger.ts.
 */
export async function rerunAnalysis(): Promise<RerunState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Требуется вход в систему." };

  const dateISO = new Date().toISOString().slice(0, 10);

  try {
    await triggerBackgroundAnalysis({ mode: "daily", dateISO, runTrigger: "manual" });
    return { started: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}
