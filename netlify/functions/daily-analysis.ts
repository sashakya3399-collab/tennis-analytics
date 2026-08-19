import { schedule } from "@netlify/functions";
import { triggerBackgroundAnalysis } from "../../src/lib/analysis/trigger";

/**
 * Netlify Scheduled Function — cron trigger only, capped at 30s by Netlify
 * regardless of plan (verified against current Netlify docs). It must NOT
 * do the actual analysis work itself (that routinely takes minutes across
 * several Gemini calls) — it just fires the Background Function
 * (run-analysis-background.ts, 15-minute budget) and returns as soon as
 * that hand-off is acknowledged.
 *
 * Default: 06:00 UTC daily. Adjust to whenever most ATP/WTA order-of-play
 * is published for the day.
 */
export const handler = schedule("0 6 * * *", async () => {
  const dateISO = new Date().toISOString().slice(0, 10);

  try {
    await triggerBackgroundAnalysis({ mode: "daily", dateISO, runTrigger: "scheduled" });
    return { statusCode: 200 };
  } catch (err) {
    console.error("Failed to trigger daily background analysis:", err);
    return { statusCode: 502 };
  }
});
