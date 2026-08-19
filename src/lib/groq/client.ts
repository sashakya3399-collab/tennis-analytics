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

/** Pulls "Please try again in 14.368s" out of a Groq 429 error body, if present. */
function parseRetryDelayMs(body: string): number | null {
  const match = body.match(/try again in ([\d.]+)s/i);
  if (!match) return null;
  const seconds = parseFloat(match[1]);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
}

const MAX_RETRIES = 2;

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

    const delayMs = res.status === 429 ? (parseRetryDelayMs(body) ?? 20_000) : 5_000;
    await sleep(Math.min(delayMs, 35_000));
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
