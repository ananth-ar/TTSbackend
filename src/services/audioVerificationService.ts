import type { AutomaticSpeechRecognitionOutput } from "@huggingface/tasks";
import {
  HF_INFERENCE_PROVIDER,
  HF_WHISPER_MODEL,
  hfInferenceClient,
} from "../config.ts";
import {
  analyzeWordOverlap,
  calculateWordMatchPercentage,
  normalizeTextForComparison,
  tokenizeForComparison,
  type WordDiffEntry,
} from "../utils/text.ts";

const DEFAULT_MATCH_THRESHOLD = 85;
const MATCH_THRESHOLD_ENV = Number.parseFloat(
  process.env.AUDIO_MATCH_THRESHOLD ?? ""
);
const MATCH_THRESHOLD =
  Number.isFinite(MATCH_THRESHOLD_ENV) && MATCH_THRESHOLD_ENV > 0
    ? Math.min(MATCH_THRESHOLD_ENV, 100)
    : DEFAULT_MATCH_THRESHOLD;

export interface AudioVerificationParams {
  expectedText: string;
  audioBuffer: Buffer;
  fileName?: string;
  mimeType?: string;
}

export interface AudioVerificationWordStats {
  totalProvidedWords: number;
  totalTranscribedWords: number;
  overlappingWordCount: number;
  missingWords: WordDiffEntry[];
  extraWords: WordDiffEntry[];
  missingWordCount: number;
  extraWordCount: number;
}

export interface AudioVerificationResult {
  success: boolean;
  matchPercent: number;
  matchThreshold: number;
  providedText: string;
  transcription: string;
  normalizedProvidedText: string;
  normalizedTranscription: string;
  wordStats: AudioVerificationWordStats;
  model: string;
  fileName?: string;
  mimeType?: string;
  inferenceResponse: AutomaticSpeechRecognitionOutput;
}

export async function transcribeAndCompareAudio(
  params: AudioVerificationParams
): Promise<AudioVerificationResult> {
  const { expectedText, audioBuffer, fileName, mimeType } = params;
  if (!hfInferenceClient) {
    throw new Error(
      "HF_TOKEN is not configured. Unable to call Hugging Face Inference API."
    );
  }

  if (!audioBuffer?.length) {
    throw new Error("Audio buffer is empty.");
  }

  const inferenceResponse = await hfInferenceClient.automaticSpeechRecognition({
    inputs: new Blob([audioBuffer], {
      type: mimeType ?? "application/octet-stream",
    }),
    model: HF_WHISPER_MODEL,
    provider: HF_INFERENCE_PROVIDER,
  });

  const transcription = extractTranscriptionText(inferenceResponse);
  if (!transcription) {
    throw new Error("Whisper transcription returned an empty result.");
  }

  const normalizedProvidedText = normalizeTextForComparison(expectedText);
  const normalizedTranscription = normalizeTextForComparison(transcription);
  const providedWords = tokenizeForComparison(expectedText);
  const transcribedWords = tokenizeForComparison(transcription);

  const matchPercent = calculateWordMatchPercentage(
    providedWords,
    transcribedWords
  );

  const overlap = analyzeWordOverlap(providedWords, transcribedWords);
  const wordStats: AudioVerificationWordStats = {
    totalProvidedWords: providedWords.length,
    totalTranscribedWords: transcribedWords.length,
    overlappingWordCount: overlap.overlappingWordCount,
    missingWords: overlap.missingWords,
    extraWords: overlap.extraWords,
    missingWordCount: overlap.missingWords.length,
    extraWordCount: overlap.extraWords.length,
  };

  const success = matchPercent >= MATCH_THRESHOLD;

  return {
    success,
    matchPercent,
    matchThreshold: MATCH_THRESHOLD,
    providedText: expectedText,
    transcription,
    normalizedProvidedText,
    normalizedTranscription,
    wordStats,
    model: HF_WHISPER_MODEL,
    fileName,
    mimeType,
    inferenceResponse,
  };
}

function extractTranscriptionText(
  output: AutomaticSpeechRecognitionOutput
): string {
  if (!output) {
    return "";
  }

  const topLevelText = (output as { text?: unknown }).text;
  if (typeof topLevelText === "string") {
    return topLevelText.trim();
  }

  const chunkResponse = (
    output as {
      chunks?: Array<{ text?: string }>;
    }
  ).chunks;
  if (Array.isArray(chunkResponse) && chunkResponse.length > 0) {
    return chunkResponse
      .map((chunk) => chunk?.text ?? "")
      .join(" ")
      .trim();
  }

  const generatedText = (output as { generated_text?: unknown }).generated_text;
  if (typeof generatedText === "string") {
    return generatedText.trim();
  }

  return "";
}
