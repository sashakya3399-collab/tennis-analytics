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

/** groq/compound — used only for the match-analysis step (real code execution). */
function getCompoundModel(): string {
  return process.env.GROQ_MODEL || "groq/compound";
}

/** A plain (non-agentic) model for text reasoning over already-fetched search context. */
function getTextModel(): string {
  return process.env.GROQ_TEXT_MODEL || "openai/gpt-oss-120b";
}

type GroqMessage = { role: "system" | "user" | "assistant"; content: string };
type GroqToolCall = { type: string; [key: string]: unknown };

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

/**
 * Two known, real, recoverable Groq failure modes (confirmed live
 * 2026-08-19) get automatic retries here rather than surfacing to the
 * caller immediately:
 * - 429 (TPM rate limit): honors the server's own suggested retry delay.
 * - 413 (compound's built-in search tool firing despite being told not
 *   to): this appears non-deterministic per call — a short-delay retry
 *   often succeeds on the next attempt without hitting the same bug.
 * Any other status is NOT retried — it's either a real error worth
 * surfacing immediately, or not something a retry would fix.
 */
async function callGroq(
  model: string,
  messages: GroqMessage[],
): Promise<{ content: string; executedTools: GroqToolCall[] }> {
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
 * Plain text reasoning over already-fetched search context (see
 * src/lib/search/tavily.ts) — no tools, no autonomous search. Used for
 * turning today's real Tavily schedule search into structured JSON.
 */
export async function generateText(systemPrompt: string, userPrompt: string): Promise<string> {
  const { content } = await callGroq(getTextModel(), [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);
  return content;
}

/**
 * Full Matrix Engine analysis call via groq/compound — real server-side
 * Python code execution for the Elo/Bayesian/Markov-chain math (confirmed
 * working live). Does NOT rely on Compound's own web search tool — that
 * currently 413s on essentially any search-triggering prompt (see
 * tavily.ts docstring) — the caller must pre-fetch real facts via Tavily
 * and embed them in matchPrompt; the prompt explicitly tells the model not
 * to search itself.
 */
export async function generateMatchAnalysis(matchPrompt: string): Promise<{
  fullText: string;
  usedCodeExecution: boolean;
  usedSearchGrounding: boolean;
}> {
  const { content, executedTools } = await callGroq(getCompoundModel(), [
    { role: "system", content: getMatrixEngineSystemPrompt() },
    { role: "user", content: matchPrompt },
  ]);

  const usedCodeExecution = executedTools.some((t) => t.type === "python" || t.type === "code");
  const usedSearchGrounding = executedTools.some((t) => t.type === "search" || t.type === "browser_search");

  return { fullText: content, usedCodeExecution, usedSearchGrounding };
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
