export type BackgroundAnalysisPayload =
  | { mode: "daily"; dateISO: string; runTrigger: "scheduled" | "manual" }
  | {
      mode: "manual_pre_match";
      playerA: string;
      playerB: string;
      surface: string | null;
      tournament: string | null;
      location: string | null;
    }
  | { mode: "manual_live"; manualAnalysisId: string; liveScore: string };

/**
 * Fires the Netlify Background Function that does the actual Groq/Tavily work
 * (netlify/functions/run-analysis-background.ts) and returns as soon as
 * Netlify's platform hands back its 202 ack — NOT once the analysis
 * itself finishes. This exists because Netlify caps synchronous
 * functions/Server Actions at 10s (free) / 26s (paid), while a single
 * Groq call with code execution routinely takes
 * 20-60+ seconds, and the daily/manual pipelines make several such calls
 * in a row — see project memory for the investigation. Background
 * Functions get a 15-minute budget instead.
 *
 * Requires running on Netlify (`netlify dev` locally, or deployed) — the
 * `URL` env var Netlify injects at runtime is what makes this reachable;
 * plain `next dev` has no Background Functions runtime to call.
 */
export async function triggerBackgroundAnalysis(payload: BackgroundAnalysisPayload): Promise<void> {
  const siteUrl = process.env.URL;
  const secret = process.env.CRON_SECRET;

  if (!siteUrl || !secret) {
    throw new Error(
      "URL and/or CRON_SECRET are not available — background analysis can only be triggered " +
        "when running on Netlify (`netlify dev` locally, or the deployed site). Plain `next dev` " +
        "has no Background Functions runtime to reach.",
    );
  }

  const res = await fetch(`${siteUrl}/.netlify/functions/run-analysis-background`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Failed to trigger background analysis (HTTP ${res.status}).`);
  }
}
