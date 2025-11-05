import path from 'node:path';
import { GoogleGenAI } from '@google/genai';

export const OUTPUT_DIR = path.resolve(process.cwd(), 'output');
export const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
export const HOST = process.env.HOST ?? '0.0.0.0';
export const MODEL_ID = process.env.GEMINI_TTS_MODEL ?? 'gemini-2.5-pro-preview-tts';
export const DEFAULT_VOICE = process.env.GEMINI_TTS_VOICE ?? 'Fenrir';
export const MAX_WORD_COUNT = 5000;
export const WORDS_PER_CHUNK = 600;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error('Set GEMINI_API_KEY before starting the server.');
}

export const aiClient = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});
