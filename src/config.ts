import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

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
