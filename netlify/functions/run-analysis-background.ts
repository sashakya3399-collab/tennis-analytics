import type { Config } from "@netlify/functions";
import { runScreenshotAnalysis, runManualLiveUpdate } from "../../src/lib/analysis/manual";
import type { BackgroundAnalysisPayload } from "../../src/lib/analysis/trigger";

/**
 * The ONE place where the actual Groq/Matrix-Engine work happens —
 * screenshot uploads and LIVE score updates funnel through this single
 * Netlify Background Function (15-minute execution budget), triggered via
 * triggerBackgroundAnalysis() from a Server Action. Kept as ONE dispatcher
 * rather than one background function per mode so there's a single place
 * that enforces the auth check and a single deploy artifact to reason
 * about.
 *
 * Imports use relative paths into src/lib, not the `@/` tsconfig alias —
 * this file is bundled by Netlify's own esbuild function bundler, not
 * Next.js's bundler, and esbuild does not resolve tsconfig path aliases
 * by default.
 */
const handler = async (req: Request) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    // The response body/status is discarded for background functions (the
    // caller always gets an immediate 202) — returning it anyway documents
    // the rejection reason for anyone reading this file.
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: BackgroundAnalysisPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  try {
    if (payload.mode === "screenshot_pre_match") {
      await runScreenshotAnalysis({ mimeType: payload.mimeType, dataBase64: payload.imageBase64 });
    } else if (payload.mode === "manual_live") {
      await runManualLiveUpdate(payload.manualAnalysisId, payload.liveScore);
    } else {
      console.error("Unknown background analysis mode:", payload);
    }
  } catch (err) {
    // manual.ts already persists its own failure state onto the relevant
    // row (manual_analyses.last_error) before rethrowing — this catch is
    // just the last-resort log, since there's no HTTP caller left waiting
    // by the time a Groq call fails.
    console.error("Background analysis run failed:", err);
  }
};

export default handler;

export const config: Config = {
  background: true,
};
