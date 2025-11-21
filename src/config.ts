import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import {
  InferenceClient,
  PROVIDERS_OR_POLICIES,
  type InferenceProviderOrPolicy,
} from "@huggingface/inference";
import OpenAI from "openai";
import type { GeminiTtsGenerationMode } from "./services/tts/types.ts";

export const OUTPUT_DIR = path.resolve(process.cwd(), "output");
export const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
export const HOST = process.env.HOST ?? "0.0.0.0";
export const MODEL_ID =
  process.env.GEMINI_TTS_MODEL ?? "gemini-2.5-flash-preview-tts";
export const DEFAULT_VOICE = process.env.GEMINI_TTS_VOICE ?? "Fenrir";
export const MAX_WORD_COUNT = 100000;
export const WORDS_PER_CHUNK = 600;
export const TOKENS_PER_SSML_CHUNK = Number.parseInt(
  process.env.SSML_TOKENS_PER_CHUNK ?? "800",
  10
);
const SSML_SYSTEM_PROMPT = process.env.SSML_SYSTEM_PROMPT;
if (!SSML_SYSTEM_PROMPT) {
  throw new Error("Set SSML_SYSTEM_PROMPT before starting the server.");
}

export const ssmlSystemPrompt = SSML_SYSTEM_PROMPT as string;

export const OPENAI_SSML_MODEL =
  process.env.OPENAI_SSML_MODEL ?? "gpt-5-mini-2025-08-07";
export const GEMINI_TTS_REQUESTS_PER_MINUTE = Number.parseInt(
  process.env.GEMINI_TTS_RPM ?? "10",
  10
);
export const GEMINI_TTS_TOKENS_PER_MINUTE = Number.parseInt(
  process.env.GEMINI_TTS_TPM ?? "10000",
  10
);
export const GEMINI_TTS_REQUESTS_PER_DAY = Number.parseInt(
  process.env.GEMINI_TTS_RPD ?? "100",
  10
);
const GEMINI_TTS_MODE_ENV = process.env.GEMINI_TTS_MODE?.toLowerCase();
const GEMINI_TTS_MODES: Record<string, GeminiTtsGenerationMode> = {
  stream: "stream",
  batch: "batch",
  parallel: "parallel",
};
export const GEMINI_TTS_MODE: GeminiTtsGenerationMode =
  GEMINI_TTS_MODES[GEMINI_TTS_MODE_ENV ?? ""] ?? "stream";
export const GEMINI_TTS_PARALLEL_CONCURRENCY = Number.parseInt(
  process.env.GEMINI_TTS_PARALLEL_CONCURRENCY ?? "8",
  10
);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error("Set OPENAI_API_KEY before starting the server.");
}

export const openaiClient = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const HF_TOKEN = process.env.HF_TOKEN;

export const hfInferenceClient = HF_TOKEN
  ? new InferenceClient(HF_TOKEN)
  : undefined;

export const HF_WHISPER_MODEL =
  process.env.HF_WHISPER_MODEL ?? "openai/whisper-large-v3";

const HF_INFERENCE_PROVIDER_ENV =
  process.env.HF_INFERENCE_PROVIDER?.toLowerCase();

export const HF_INFERENCE_PROVIDER: InferenceProviderOrPolicy =
  (HF_INFERENCE_PROVIDER_ENV &&
    (PROVIDERS_OR_POLICIES as readonly string[]).includes(
      HF_INFERENCE_PROVIDER_ENV
    ) &&
    (HF_INFERENCE_PROVIDER_ENV as InferenceProviderOrPolicy)) ||
  "hf-inference";

function resolveGeminiApiKeys(
  primaryKey: string | undefined,
  additionalKeys: string | undefined
): string[] {
  const parsedAdditional = parseApiKeyList(additionalKeys);
  const combined = [
    normalizeApiKey(primaryKey),
    ...parsedAdditional.map((key) => normalizeApiKey(key)),
  ].filter((key): key is string => Boolean(key));

  const uniqueKeys = Array.from(new Set(combined));
  if (!uniqueKeys.length) {
    throw new Error(
      "Set GEMINI_API_KEY or GEMINI_API_KEYS before starting the server."
    );
  }

  return uniqueKeys;
}

function parseApiKeyList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => normalizeApiKey(entry))
          .filter((key): key is string => Boolean(key));
      }
    } catch {
      // Fall through to comma parsing below.
    }
  }

  return trimmed
    .split(",")
    .map((segment) => normalizeApiKey(segment))
    .filter((key): key is string => Boolean(key));
}

function normalizeApiKey(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length ? normalized : undefined;
  }

  return undefined;
}

class GeminiClientManager {
  private readonly entries: GeminiClientEntry[];
  private nextIndex = 0;

  constructor(apiKeys: string[]) {
    this.entries = apiKeys.map((apiKey, index) => ({
      client: new GoogleGenAI({ apiKey }),
      index,
      redactedKey: redactApiKey(apiKey),
    }));
  }

  get size(): number {
    return this.entries.length;
  }

  async run<T>(executor: (client: GoogleGenAI) => Promise<T>): Promise<T> {
    if (!this.entries.length) {
      throw new Error("No Gemini API clients were configured.");
    }

    const tried = new Set<number>();
    let lastError: unknown;

    while (tried.size < this.entries.length) {
      const entry = this.pickNextEntry();
      tried.add(entry.index);

      try {
        return await executor(entry.client);
      } catch (error) {
        lastError = error;
        if (!shouldRotateGeminiKey(error) || this.entries.length === 1) {
          throw error;
        }

        console.warn(
          `[Gemini] API key ${entry.index + 1}/${this.entries.length} (${
            entry.redactedKey
          }) hit a quota limit or rate cap; rotating to the next key.`
        );
      }
    }

    throw lastError ?? new Error("All Gemini API keys are exhausted.");
  }

  private pickNextEntry(): GeminiClientEntry {
    if (!this.entries.length) {
      throw new Error("No Gemini API clients were configured.");
    }

    if (this.entries.length === 1) {
      const singleEntry = this.entries[0];
      if (!singleEntry) {
        throw new Error("Gemini API client entry is missing.");
      }
      return singleEntry;
    }

    const entry = this.entries[this.nextIndex];
    if (!entry) {
      throw new Error("Gemini API client entry is missing.");
    }
    this.nextIndex = (this.nextIndex + 1) % this.entries.length;
    return entry;
  }
}

interface GeminiClientEntry {
  client: GoogleGenAI;
  index: number;
  redactedKey: string;
}

function redactApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 4)}***`;
  }

  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function shouldRotateGeminiKey(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const numericCode = extractNumericStatus(error);
  if (numericCode === 429) {
    return true;
  }

  const statusText = `${extractStatusText(error)} ${extractErrorMessage(
    error
  )}`.toLowerCase();
  return (
    statusText.includes("quota") ||
    statusText.includes("resource_exhausted") ||
    statusText.includes("too many requests") ||
    statusText.includes("rate limit")
  );
}

function extractNumericStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidateValues: Array<number | undefined> = [];
  const topLevel = error as Record<string, unknown>;

  candidateValues.push(asNumber(topLevel.code));
  candidateValues.push(asNumber(topLevel.status));

  if (typeof topLevel.error === "object" && topLevel.error) {
    const nested = topLevel.error as Record<string, unknown>;
    candidateValues.push(asNumber(nested.code));
    candidateValues.push(asNumber(nested.status));
  }

  return candidateValues.find((value) => typeof value === "number");
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function extractStatusText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }

  const topLevel = error as Record<string, unknown>;
  const statusValues: unknown[] = [
    topLevel.status,
    topLevel.error && typeof topLevel.error === "object"
      ? (topLevel.error as Record<string, unknown>).status
      : undefined,
  ];

  return statusValues
    .map((value) => (typeof value === "string" ? value : ""))
    .filter(Boolean)
    .join(" ");
}

function extractErrorMessage(error: unknown): string {
  if (!error) {
    return "";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const geminiApiKeys = resolveGeminiApiKeys(
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEYS
);

export const geminiClientManager = new GeminiClientManager(geminiApiKeys);

export function runWithGeminiClient<T>(
  executor: (client: GoogleGenAI) => Promise<T>
): Promise<T> {
  return geminiClientManager.run(executor);
}
