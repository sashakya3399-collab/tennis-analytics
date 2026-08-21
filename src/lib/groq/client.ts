import { MATRIX_ENGINE_SYSTEM_PROMPT } from "./system-prompt";

/**
 * The full 116-rule Tennis Quant Matrix Engine spec (+ founder addendum),
 * used as the system message. Embedded as a TS module rather than read
 * from disk at runtime — a raw Netlify Background Function doesn't
 * reliably ship/resolve loose static files the way the Next.js app does,
 * so a plain module import is the one approach that works in both
 * bundlers.
 */
export function getMatrixEngineSystemPrompt(): string {
  return MATRIX_ENGINE_SYSTEM_PROMPT;
}

/** Vision-capable model — screenshot extraction only, no tools. Free tier: 30 RPM / 1000 RPD, no card. */
function getVisionModel(): string {
  return process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";
}

/** groq/compound — real server-side Python code execution. Free tier: 30 RPM / 250 RPD, no card. */
function getCompoundModel(): string {
  return process.env.GROQ_MODEL || "groq/compound";
}

export type GroqImage = { mimeType: string; dataBase64: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pulls the suggested wait out of a Groq 429 error body, if present. Groq
 * uses two formats depending on the limit hit: "try again in 14.368s"
 * (TPM, seconds only) and "try again in 1m49.900799999s" (TPD — daily
 * token cap, minutes+seconds — confirmed live 2026-08-19 on a real
 * deployed-site request). The original regex only matched the
 * seconds-only form, silently truncating "1m49.9s" down to "1" (one
 * second) and causing the retry to fire far too early and fail again.
 */
function parseRetryDelayMs(body: string): number | null {
  const match = body.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  if (!match) return null;
  const minutes = match[1] ? parseInt(match[1], 10) : 0;
  const seconds = parseFloat(match[2]);
  if (!Number.isFinite(seconds)) return null;
  return Math.ceil((minutes * 60 + seconds) * 1000);
}

// Raised from 2 (2026-08-21): a real 429 showed compound's internal
// routing model (meta-llama/llama-4-scout-17b-16e-instruct) has its OWN
// tighter 30K-TPM sub-limit, separate from compound's own 70K-TPM headline
// limit — a single heavy call needing ~18K tokens against an already
// ~26K-used window can need more than 2 retries to land. Briefly raised to
// 5, then found the REAL driver of repeated failure was two overlapping
// runs (nothing blocked a second screenshot submission while the first
// was still retrying) both hammering this same 30K/min budget — fixed at
// the source via a 'processing'-status guard (manual.ts /
// manual-analysis.ts), which also means a longer retry chain no longer
// extends a collision window the way it did before that guard existed.
// Settled on 4: comfortable margin for a single in-flight run's own
// natural TPM recovery, without an excessively long-lived retry chain.
const MAX_RETRIES = 4;

type GroqToolCall = { type: string; [key: string]: unknown };
type GroqCallResult = { content: string; executedTools: GroqToolCall[] };

/**
 * One real chat.completions call. Retries on 429 (TPM/RPM rate limit,
 * honors the server's own suggested delay) and 413 (compound's built-in
 * search tool firing despite not being invoked in the prompt — confirmed
 * non-deterministic live in this project's earlier Groq round). Any other
 * status is not retried.
 */
async function callGroq(
  model: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: unknown }>,
): Promise<GroqCallResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set. Add it to .env.local.");
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
    });

    if (res.ok) {
      const data = await res.json();
      const message = data.choices?.[0]?.message;
      const content: string | undefined = message?.content;
      if (!content) throw new Error("Groq returned an empty response.");
      return { content, executedTools: message?.executed_tools ?? [] };
    }

    const body = await res.text();
    lastError = new Error(`Groq API call failed (HTTP ${res.status}): ${body.slice(0, 500)}`);

    const canRetry = attempt < MAX_RETRIES && (res.status === 429 || res.status === 413);
    if (!canRetry) throw lastError;

    // +3s safety buffer on 429s: Groq's suggested delay is computed at the
    // moment of the error, but other concurrent org-wide usage can eat the
    // freed-up headroom before this retry actually lands (observed live,
    // 2026-08-21) — a small buffer costs little against a 15-minute budget.
    const delayMs = res.status === 429 ? (parseRetryDelayMs(body) ?? 20_000) + 3_000 : 5_000;
    // Cap raised from 35s to 150s (2026-08-19): a real TPD (tokens-per-day)
    // 429 suggested a ~110s wait, which the old 35s cap would have
    // truncated, guaranteeing the retry fires too early and fails again.
    // The Background Function has a 15-minute budget, so this is still a
    // small fraction of it even with MAX_RETRIES raised to 5.
    await sleep(Math.min(delayMs, 150_000));
  }

  throw lastError ?? new Error("Groq API call failed after retries.");
}

/**
 * Reads the uploaded screenshot (vision, no tools) — extracts players,
 * surface, court/tournament, and the total-games-1st-set diapason. Kept as
 * its own call/model (qwen/qwen3.6-27b) separate from the math analysis
 * (groq/compound), since the two free-tier quotas are independent (30 RPM/
 * 1000 RPD vs. 30 RPM/250 RPD) and vision + Groq's own code execution
 * aren't confirmed to work reliably in a single call.
 */
export async function extractFromScreenshot(image: GroqImage, prompt: string): Promise<string> {
  const { content } = await callGroq(getVisionModel(), [
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` } },
        { type: "text", text: prompt },
      ],
    },
  ]);
  return content;
}

/**
 * Full Matrix Engine analysis via groq/compound — real server-side Python
 * code execution for the SET 1 Elo/Bayesian/Markov-chain math. Does NOT
 * rely on Compound's own web search tool — that 413s on essentially any
 * search-triggering prompt (confirmed live, corroborated on Groq's own
 * community forum) — the caller must pre-fetch real facts (screenshot
 * extraction + Tavily search) and embed them in matchPrompt; the prompt
 * explicitly tells the model not to search itself.
 */
export async function generateMatchAnalysis(matchPrompt: string): Promise<{
  fullText: string;
  usedCodeExecution: boolean;
}> {
  const { content, executedTools } = await callGroq(getCompoundModel(), [
    { role: "system", content: getMatrixEngineSystemPrompt() },
    { role: "user", content: matchPrompt },
  ]);

  const usedCodeExecution = executedTools.some((t) => t.type === "python" || t.type === "code");

  return { fullText: content, usedCodeExecution };
}

/**
 * Extracts a trailing ```json ... ``` fenced block from a model response.
 * The analysis prompt asks the model to end its report with exactly one
 * such block containing the structured fields we store as columns; the
 * rest of the text is kept verbatim as the full human-readable report.
 */
export function extractTrailingJsonBlock(text: string): Record<string, unknown> | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1][1];
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}
