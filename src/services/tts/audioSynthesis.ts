import mime from "mime";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { GoogleGenAI } from "@google/genai";

import {
  GEMINI_TTS_MODE,
  GEMINI_TTS_PARALLEL_CONCURRENCY,
  GEMINI_TTS_REQUESTS_PER_MINUTE,
  GEMINI_TTS_TOKENS_PER_MINUTE,
  DEFAULT_VOICE,
  MODEL_ID,
  runWithGeminiClient,
} from "../../config.ts";
import { ensureDirectory } from "../../utils/fs.ts";
import { combineAudioChunks, convertBase64ToWav, type AudioChunk } from "../../utils/audio.ts";
import { countTokens } from "../../utils/text.ts";
import { writeJsonFile } from "../../utils/json.ts";
import type {
  ChunkAudioJobResult,
  PersistedAudio,
  SsmlChunkTask,
  SynthesizeAudioOptions,
} from "./types.ts";
import {
  synthesizeAudioFromSsmlChunksBatch,
  type BatchSynthesizeAudioOptions,
} from "./batchAudioSynthesis.ts";

interface InlineDataPart {
  inlineData?: {
    data?: string;
    mimeType?: string;
  };
}

const REQUEST_WINDOW_MS = 60_000;
const MIN_WAIT_MS = 100;

export async function synthesizeAudioFromSsmlChunks(
  chunkTasks: SsmlChunkTask[],
  customVoice?: string,
  options?: SynthesizeAudioOptions
): Promise<ChunkAudioJobResult[]> {
  const preferredMode = options?.modeOverride ?? GEMINI_TTS_MODE;
  if (preferredMode === "batch") {
    return synthesizeAudioFromSsmlChunksBatch(
      chunkTasks,
      customVoice,
      options as BatchSynthesizeAudioOptions
    );
  }

  if (preferredMode === "parallel") {
    return synthesizeAudioFromSsmlChunksParallel(chunkTasks, customVoice, options);
  }

  return synthesizeAudioFromSsmlChunksStream(chunkTasks, customVoice, options);
}

async function synthesizeAudioFromSsmlChunksStream(
  chunkTasks: SsmlChunkTask[],
  customVoice?: string,
  options?: SynthesizeAudioOptions
): Promise<ChunkAudioJobResult[]> {
  if (!chunkTasks.length) {
    throw new Error("No SSML chunk tasks were provided for synthesis.");
  }

  const voice = customVoice ?? DEFAULT_VOICE;
  const jobLabel = createJobLabel(options?.jobId, "TTS");
  const totalChunkCount =
    options?.totalChunkCount ??
    chunkTasks.reduce((max, task) => Math.max(max, task.chunkIndex), 0);

  console.log(
    `${jobLabel}Starting audio synthesis for ${chunkTasks.length} chunk task(s) using voice "${voice}" (sequential).`
  );

  const results: ChunkAudioJobResult[] = [];

  for (const task of chunkTasks) {
    const result = await runChunkSynthesisTask(task, {
      voice,
      jobLabel,
      totalChunkCount,
    });
    results.push(result);
  }

  return results;
}

async function synthesizeAudioFromSsmlChunksParallel(
  chunkTasks: SsmlChunkTask[],
  customVoice?: string,
  options?: SynthesizeAudioOptions
): Promise<ChunkAudioJobResult[]> {
  if (!chunkTasks.length) {
    throw new Error("No SSML chunk tasks were provided for synthesis.");
  }

  const voice = customVoice ?? DEFAULT_VOICE;
  const jobLabel = createJobLabel(options?.jobId, "TTS-PAR");
  const totalChunkCount =
    options?.totalChunkCount ??
    chunkTasks.reduce((max, task) => Math.max(max, task.chunkIndex), 0);
  const parallelism = resolveParallelism(
    chunkTasks.length,
    options?.parallelism
  );
  const workerCount = Math.min(parallelism, chunkTasks.length);

  console.log(
    `${jobLabel}Starting parallel audio synthesis for ${chunkTasks.length} chunk task(s) using voice "${voice}" with concurrency ${workerCount}.`
  );

  let nextIndex = 0;
  const results: ChunkAudioJobResult[] = [];

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex++;
      const task = chunkTasks[currentIndex];
      if (!task) {
        break;
      }
      const result = await runChunkSynthesisTask(task, {
        voice,
        jobLabel,
        totalChunkCount,
      });
      results.push(result);
    }
  });

  await Promise.all(workers);

  return results;
}

interface ChunkSynthesisContext {
  voice: string;
  jobLabel: string;
  totalChunkCount: number;
}

async function runChunkSynthesisTask(
  task: SsmlChunkTask,
  context: ChunkSynthesisContext
): Promise<ChunkAudioJobResult> {
  const { voice, jobLabel, totalChunkCount } = context;
  const chunkNumber = task.chunkIndex;
  const chunkLabel = `${chunkNumber}/${totalChunkCount}`;

  let ssml: string | undefined;
  try {
    ssml = await readFile(task.ssmlFilePath, { encoding: "utf8" });
  } catch (error) {
    const message = `${jobLabel}Unable to read SSML for chunk ${chunkLabel}.`;
    console.error(message, error);
    await writeJsonFile(task.audioStatusFilePath, {
      status: "failed",
      attempt: task.attempt,
      updatedAt: new Date().toISOString(),
      message,
    });
    return {
      chunkIndex: chunkNumber,
      attempt: task.attempt,
      success: false,
      error: message,
    };
  }

  const normalized = ssml?.trim();
  if (!normalized) {
    const message = `${jobLabel}Chunk ${chunkLabel} SSML content is empty.`;
    console.error(message);
    await writeJsonFile(task.audioStatusFilePath, {
      status: "failed",
      attempt: task.attempt,
      updatedAt: new Date().toISOString(),
      message,
    });
    return {
      chunkIndex: chunkNumber,
      attempt: task.attempt,
      success: false,
      error: message,
    };
  }

  const tokensNeeded = Math.max(1, countTokens(normalized));
  console.log(
    `${jobLabel}Queueing chunk ${chunkLabel} (~${tokensNeeded} tokens).`
  );

  await writeJsonFile(task.audioStatusFilePath, {
    status: "in-progress",
    attempt: task.attempt,
    updatedAt: new Date().toISOString(),
    message: "Audio generation started.",
  });

  await ttsRateLimiter.waitForTurn(
    tokensNeeded,
    jobLabel,
    chunkNumber,
    totalChunkCount
  );

  try {
    const chunkAudio = await generateAudioWithRetry({
      ssml: normalized,
      voiceName: voice,
      jobLabel,
      chunkNumber,
      totalChunks: totalChunkCount,
    });

    const extension = mime.getExtension(chunkAudio.mimeType) ?? "wav";
    const audioFileName = `chunk-${chunkNumber}.${extension}`;
    const audioFilePath = path.join(task.chunkDir, audioFileName);
    await writeFile(audioFilePath, chunkAudio.buffer);

    await writeJsonFile(task.audioMetadataFilePath, {
      chunkIndex: chunkNumber,
      attempt: task.attempt,
      mimeType: chunkAudio.mimeType,
      fileName: audioFileName,
      updatedAt: new Date().toISOString(),
    });

    await writeJsonFile(task.audioStatusFilePath, {
      status: "success",
      attempt: task.attempt,
      updatedAt: new Date().toISOString(),
      message: `Audio chunk saved (${chunkAudio.mimeType}).`,
    });

    console.log(
      `${jobLabel}Chunk ${chunkLabel} saved to ${audioFilePath} (${chunkAudio.mimeType}).`
    );

    return {
      chunkIndex: chunkNumber,
      attempt: task.attempt,
      success: true,
      audioFilePath,
      mimeType: chunkAudio.mimeType,
    };
  } catch (error) {
    const message = `${jobLabel}Chunk ${chunkLabel} synthesis failed.`;
    console.error(message, error);
    await writeJsonFile(task.audioStatusFilePath, {
      status: "failed",
      attempt: task.attempt,
      updatedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : message,
    });
    return {
      chunkIndex: chunkNumber,
      attempt: task.attempt,
      success: false,
      error: error instanceof Error ? error.message : message,
    };
  }
}

function resolveParallelism(
  chunkCount: number,
  override?: number
): number {
  const rpmLimit =
    GEMINI_TTS_REQUESTS_PER_MINUTE > 0
      ? GEMINI_TTS_REQUESTS_PER_MINUTE
      : chunkCount;
  const envDefault =
    Number.isFinite(GEMINI_TTS_PARALLEL_CONCURRENCY) &&
    GEMINI_TTS_PARALLEL_CONCURRENCY > 0
      ? GEMINI_TTS_PARALLEL_CONCURRENCY
      : 1;
  const desired = override && override > 0 ? override : envDefault;
  const ceiling = Math.max(1, Math.min(chunkCount, rpmLimit || chunkCount));
  return Math.max(1, Math.min(desired, ceiling));
}

export async function combineChunkAudioFiles(
  chunkFiles: Array<{ filePath: string; mimeType: string }>,
  finalFilePath: string,
  options?: { jobId?: string }
): Promise<PersistedAudio> {
  if (!chunkFiles.length) {
    throw new Error("No chunk files available to merge.");
  }

  const jobLabel = createJobLabel(options?.jobId, "TTS-MERGE");
  const audioChunks: AudioChunk[] = [];

  for (const chunk of chunkFiles) {
    const buffer = await readFile(chunk.filePath);
    audioChunks.push({
      buffer,
      mimeType: chunk.mimeType,
    });
  }

  const combinedAudio = combineAudioChunks(audioChunks);
  await ensureDirectory(path.dirname(finalFilePath));
  await writeFile(finalFilePath, combinedAudio.buffer);
  console.log(`${jobLabel}Final audio file saved to ${finalFilePath}`);

  return {
    fileName: path.basename(finalFilePath),
    filePath: finalFilePath,
    mimeType: combinedAudio.mimeType,
  };
}

interface GenerateAudioRequest {
  ssml: string;
  voiceName: string;
  jobLabel: string;
  chunkNumber: number;
  totalChunks: number;
}

const MAX_TTS_STREAM_ATTEMPTS = 3;
const BASE_TTS_RETRY_DELAY_MS = 1_000;
const TTS_RETRY_BACKOFF_FACTOR = 2;

async function generateAudioWithRetry(options: GenerateAudioRequest): Promise<AudioChunk> {
  return runWithGeminiClient(async (client) => {
    const { ssml, voiceName, jobLabel, chunkNumber, totalChunks } = options;
    let attempt = 0;
    let lastError: unknown;

    while (attempt < MAX_TTS_STREAM_ATTEMPTS) {
      attempt += 1;
      try {
        return await generateAudioFromSsml(
          client,
          ssml,
          voiceName,
          jobLabel,
          chunkNumber,
          totalChunks
        );
      } catch (error) {
        lastError = error;

        if (!shouldRetryTtsError(error) || attempt >= MAX_TTS_STREAM_ATTEMPTS) {
          break;
        }

        const backoffDelay =
          BASE_TTS_RETRY_DELAY_MS * Math.pow(TTS_RETRY_BACKOFF_FACTOR, attempt - 1);
        console.warn(
          `${jobLabel}Chunk ${chunkNumber}/${totalChunks} attempt ${attempt} failed (${error instanceof Error ? error.message : String(
            error
          )}). Retrying in ${backoffDelay}ms.`
        );
        await delay(backoffDelay);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Gemini audio request failed after retries.");
  });
}

async function generateAudioFromSsml(
  client: GoogleGenAI,
  ssml: string,
  voiceName: string,
  jobLabel: string,
  chunkNumber: number,
  totalChunks: number
): Promise<AudioChunk> {
  console.log(
    `${jobLabel}Requesting Gemini audio for chunk ${chunkNumber}/${totalChunks}.`
  );

  const contents = [
    {
      role: "user" as const,
      parts: [{ text: ssml }],
    },
  ];

  const response = await client.models.generateContentStream({
    model: MODEL_ID,
    config: {
      temperature: 0.7,
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName,
          },
        },
      },
    },
    contents,
  });

  const base64Chunks: string[] = [];
  let mimeType: string | undefined;

  for await (const chunk of response) {
    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    for (const part of parts) {
      const inlineData = (part as InlineDataPart).inlineData;
      if (!inlineData) {
        continue;
      }

      if (inlineData.data) {
        base64Chunks.push(inlineData.data);
      }

      if (inlineData.mimeType) {
        mimeType = inlineData.mimeType;
      }
    }
  }

  if (!base64Chunks.length) {
    throw new Error("Gemini did not return audio data.");
  }

  console.log(
    `${jobLabel}Chunk ${chunkNumber}/${totalChunks} audio stream received (${
      mimeType ?? "audio/wav"
    }).`
  );

  const combinedBase64 = base64Chunks.join("");
  if (!mimeType || !mime.getExtension(mimeType)) {
    return {
      buffer: convertBase64ToWav(combinedBase64, mimeType),
      mimeType: "audio/wav",
    };
  }

  return {
    buffer: Buffer.from(combinedBase64, "base64"),
    mimeType,
  };
}

function shouldRetryTtsError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (error instanceof TypeError) {
    return true;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("fetch failed") ||
      message.includes("terminated") ||
      message.includes("network") ||
      message.includes("socket")
    );
  }

  return false;
}

class TtsRateLimiter {
  private requestTimestamps: number[] = [];
  private tokenHistory: Array<{ timestamp: number; tokens: number }> = [];

  async waitForTurn(
    tokensNeeded: number,
    jobLabel: string,
    chunkNumber: number,
    totalChunks: number
  ): Promise<void> {
    while (true) {
      const now = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter(
        (timestamp) => now - timestamp < REQUEST_WINDOW_MS
      );
      this.tokenHistory = this.tokenHistory.filter(
        ({ timestamp }) => now - timestamp < REQUEST_WINDOW_MS
      );

      const requestsUsed = this.requestTimestamps.length;
      const tokensUsed = this.tokenHistory.reduce(
        (sum, { tokens }) => sum + tokens,
        0
      );

      const requestLimitOk =
        requestsUsed < GEMINI_TTS_REQUESTS_PER_MINUTE ||
        GEMINI_TTS_REQUESTS_PER_MINUTE === 0;
      const tokenLimitOk =
        tokensUsed + tokensNeeded <= GEMINI_TTS_TOKENS_PER_MINUTE ||
        GEMINI_TTS_TOKENS_PER_MINUTE === 0;

      if (requestLimitOk && tokenLimitOk) {
        break;
      }

      const oldestRequestTimestamp = this.requestTimestamps[0];
      const nextRequestDelay =
        requestLimitOk || oldestRequestTimestamp === undefined
          ? 0
          : REQUEST_WINDOW_MS - (now - oldestRequestTimestamp);
      const oldestTokenTimestamp = this.tokenHistory[0]?.timestamp;
      const nextTokenDelay =
        tokenLimitOk || !oldestTokenTimestamp
          ? 0
          : REQUEST_WINDOW_MS - (now - oldestTokenTimestamp);

      const waitMs = Math.max(nextRequestDelay, nextTokenDelay, MIN_WAIT_MS);
      console.log(
        `${jobLabel}Rate limit guard active before chunk ${chunkNumber}/${totalChunks}. Waiting ${waitMs}ms.`
      );
      await delay(waitMs);
    }

    const timestamp = Date.now();
    this.requestTimestamps.push(timestamp);
    this.tokenHistory.push({ timestamp, tokens: tokensNeeded });
  }
}

const ttsRateLimiter = new TtsRateLimiter();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createJobLabel(jobId: string | undefined, fallback: string): string {
  if (jobId) {
    return `[Job ${jobId}][${fallback}] `;
  }

  return `[${fallback}] `;
}
