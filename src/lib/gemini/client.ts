import { GoogleGenAI } from "@google/genai";
import { MATRIX_ENGINE_SYSTEM_PROMPT } from "./system-prompt";

/**
 * The full 116-rule Tennis Quant Matrix Engine spec (+ founder addendum),
 * used as systemInstruction. Embedded as a TS module rather than read from
 * disk at runtime — a raw Netlify Background Function (see
 * netlify/functions/run-analysis-background.ts) doesn't reliably ship or
 * resolve loose static files the way the Next.js app does, so a plain
 * module import is the one approach that works in both bundlers.
 */
export function getMatrixEngineSystemPrompt(): string {
  return MATRIX_ENGINE_SYSTEM_PROMPT;
}

export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL || "gemini-2.5-pro";
}

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set. Add it to .env.local.");
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Search-grounded call with no code execution — used for factual lookups
 * (today's schedule, tournament/location facts) where math isn't needed.
 * Note: responseSchema/JSON mode is NOT combined with tools here — the
 * Gemini API does not support structured-output mode together with the
 * googleSearch/codeExecution tools, so instead we instruct the model to
 * emit a bare JSON array/object in `text` and parse it on our side.
 */
export async function generateGrounded(prompt: string): Promise<string> {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: getGeminiModel(),
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
    },
  });
  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response for a grounded call.");
  return text;
}

/**
 * Full Matrix Engine analysis call: systemInstruction = the 116-rule spec,
 * both googleSearch (for live player/surface/H2H facts) and codeExecution
 * (for the actual Elo/Bayesian/Markov-chain math the spec requires) enabled
 * per Google's docs, which state the two tools can be combined in one call.
 */
export async function generateMatchAnalysis(matchPrompt: string): Promise<{
  fullText: string;
  usedCodeExecution: boolean;
  usedSearchGrounding: boolean;
}> {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: getGeminiModel(),
    contents: matchPrompt,
    config: {
      systemInstruction: getMatrixEngineSystemPrompt(),
      tools: [{ googleSearch: {} }, { codeExecution: {} }],
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response for a match analysis call.");

  const candidateParts = response.candidates?.[0]?.content?.parts ?? [];
  const usedCodeExecution = candidateParts.some(
    (part) => part.executableCode || part.codeExecutionResult,
  );
  const usedSearchGrounding = Boolean(
    response.candidates?.[0]?.groundingMetadata?.groundingChunks?.length,
  );

  return { fullText: text, usedCodeExecution, usedSearchGrounding };
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
