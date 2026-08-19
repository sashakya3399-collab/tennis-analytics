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

/** GA, cheap, default model — used for schedule extraction and the first pass of every match analysis. */
export function getFlashModel(): string {
  return process.env.GEMINI_MODEL_FLASH || "gemini-3.6-flash";
}

/** Frontier-tier reasoning model — only used to re-run a match the Flash pass itself flagged as uncertain. */
export function getProModel(): string {
  return process.env.GEMINI_MODEL_PRO || "gemini-3.1-pro-preview";
}

export type GeminiTool = "googleSearch" | "codeExecution";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gemini rate-limit errors carry the suggested wait as a structured
 * google.rpc.RetryInfo detail (e.g. `{"retryDelay": "13s"}`), not the plain
 * "try again in Xs" text Groq used — parse that shape, falling back to a
 * fixed delay when it's absent (some 429s omit it).
 */
function parseRetryDelayMs(errorBody: string): number | null {
  try {
    const parsed = JSON.parse(errorBody);
    const details: unknown[] = parsed?.error?.details ?? [];
    for (const detail of details) {
      const retryDelay = (detail as { retryDelay?: string })?.retryDelay;
      if (typeof retryDelay === "string") {
        const seconds = parseFloat(retryDelay.replace("s", ""));
        if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000);
      }
    }
  } catch {
    // fall through to null
  }
  return null;
}

const MAX_RETRIES = 2;

type GeminiCallResult = {
  fullText: string;
  usedCodeExecution: boolean;
  usedSearchGrounding: boolean;
};

/**
 * One real generateContent call. Retries on 429 (honoring the server's
 * RetryInfo delay when present) and 503 (model temporarily overloaded —
 * common on preview models under load) since both are genuinely
 * recoverable; anything else surfaces immediately.
 */
async function callGemini(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  tools: GeminiTool[],
): Promise<GeminiCallResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set. Add it to .env.local.");
  }

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    tools: tools.map((t) => ({ [t]: {} })),
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (res.ok) {
      const data = await res.json();
      const candidate = data.candidates?.[0];
      const parts: Array<Record<string, unknown>> = candidate?.content?.parts ?? [];
      if (parts.length === 0) throw new Error("Gemini returned an empty response.");

      const fullText = parts
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("")
        .trim();
      if (!fullText) throw new Error("Gemini returned no text content.");

      const usedCodeExecution = parts.some((p) => "executableCode" in p || "codeExecutionResult" in p);
      const usedSearchGrounding = Boolean(candidate?.groundingMetadata);

      return { fullText, usedCodeExecution, usedSearchGrounding };
    }

    const errorBody = await res.text();
    lastError = new Error(`Gemini API call failed (HTTP ${res.status}): ${errorBody.slice(0, 500)}`);

    const canRetry = attempt < MAX_RETRIES && (res.status === 429 || res.status === 503);
    if (!canRetry) throw lastError;

    const delayMs = res.status === 429 ? (parseRetryDelayMs(errorBody) ?? 15_000) : 8_000;
    await sleep(Math.min(delayMs, 35_000));
  }

  throw lastError ?? new Error("Gemini API call failed after retries.");
}

/**
 * Runs one prompt against the Flash model with both tools enabled
 * (search + code execution in a single agentic call — Gemini decides on
 * its own whether/how many times to search, unlike the old Tavily
 * pre-fetch step).
 */
export async function generateWithFlash(
  systemPrompt: string,
  userPrompt: string,
  tools: GeminiTool[] = ["googleSearch", "codeExecution"],
): Promise<GeminiCallResult> {
  return callGemini(getFlashModel(), systemPrompt, userPrompt, tools);
}

/** Same call, but on the Pro-tier reasoning model — only used for escalation, see analyzeMatch(). */
export async function generateWithPro(
  systemPrompt: string,
  userPrompt: string,
  tools: GeminiTool[] = ["googleSearch", "codeExecution"],
): Promise<GeminiCallResult> {
  return callGemini(getProModel(), systemPrompt, userPrompt, tools);
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
