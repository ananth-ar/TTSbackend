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
  process.env.GEMINI_TTS_MODEL ?? "models/gemini-2.5-flash-preview-tts";
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
  process.env.GEMINI_TTS_PARALLEL_CONCURRENCY ?? "10",
  10
);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error("Set GEMINI_API_KEY before starting the server.");
}

export const aiClient = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

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
