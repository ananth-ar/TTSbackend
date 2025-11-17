import mime from "mime";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import {
  DEFAULT_VOICE,
  GEMINI_TTS_REQUESTS_PER_DAY,
  MODEL_ID,
  runWithGeminiClient,
} from "../../config.ts";
import { convertBase64ToWav, type AudioChunk } from "../../utils/audio.ts";
import { writeJsonFile } from "../../utils/json.ts";
import type {
  ChunkAudioJobResult,
  SsmlChunkTask,
  SynthesizeAudioOptions,
} from "./types.ts";
import {
  JobState,
  type BatchJob,
  type GenerateContentResponse,
  type GoogleGenAI,
  type InlinedRequest,
  type InlinedResponse,
} from "@google/genai";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_BATCH_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const TERMINAL_STATES: Set<JobState> = new Set([
  JobState.JOB_STATE_SUCCEEDED,
  JobState.JOB_STATE_PARTIALLY_SUCCEEDED,
  JobState.JOB_STATE_FAILED,
  JobState.JOB_STATE_CANCELLED,
  JobState.JOB_STATE_EXPIRED,
]);

export interface BatchSynthesizeAudioOptions extends SynthesizeAudioOptions {
  pollIntervalMs?: number;
  maxWaitMs?: number;
  maxBatchAttempts?: number;
  retryDelayMs?: number;
}

interface InlineDataPart {
  inlineData?: {
    data?: string;
    mimeType?: string;
  };
}

interface BatchChunkContext {
  zeroIndex: number;
  chunkIndex: number;
  chunkLabel: string;
  attempt: number;
  task: SsmlChunkTask;
  ssml: string;
}

interface QuotaReservation {
  commit(): void;
  release(): void;
}

export async function synthesizeAudioFromSsmlChunksBatch(
  chunkTasks: SsmlChunkTask[],
  customVoice?: string,
  options?: BatchSynthesizeAudioOptions
): Promise<ChunkAudioJobResult[]> {
  if (!chunkTasks.length) {
    throw new Error("No SSML chunk tasks were provided for synthesis.");
  }

  const voice = customVoice ?? DEFAULT_VOICE;
  const jobLabel = createJobLabel(options?.jobId);
  const pollInterval =
    options?.pollIntervalMs && options.pollIntervalMs > 0
      ? options.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const maxAttempts =
    options?.maxBatchAttempts && options.maxBatchAttempts > 0
      ? options.maxBatchAttempts
      : DEFAULT_MAX_BATCH_ATTEMPTS;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const totalChunks = options?.totalChunkCount ?? chunkTasks.length;

  console.log(
    `${jobLabel}Starting Gemini Batch synthesis for ${chunkTasks.length} chunk task(s) using voice "${voice}".`
  );

  const ssmlChunks: string[] = [];
  const chunkContexts = new Map<number, BatchChunkContext>();
  const initialFailures: ChunkAudioJobResult[] = [];
  const pendingSeed: number[] = [];

  for (const task of chunkTasks) {
    const chunkIndex = task.chunkIndex;
    const chunkLabel = `${chunkIndex}/${totalChunks}`;
    const attempt = task.attempt;
    let ssml: string | undefined;

    try {
      ssml = await readFile(task.ssmlFilePath, { encoding: "utf8" });
    } catch (error) {
      const message = `${jobLabel}Unable to read SSML for chunk ${chunkLabel}.`;
      console.error(message, error);
      await writeJsonFile(task.audioStatusFilePath, {
        status: "failed",
        attempt,
        updatedAt: new Date().toISOString(),
        message,
      });
      initialFailures.push({
        chunkIndex,
        attempt,
        success: false,
        error: message,
      });
      continue;
    }

    if (!ssml?.trim()) {
      const message = `${jobLabel}Chunk ${chunkLabel} SSML content is empty.`;
      console.error(message);
      await writeJsonFile(task.audioStatusFilePath, {
        status: "failed",
        attempt,
        updatedAt: new Date().toISOString(),
        message,
      });
      initialFailures.push({
        chunkIndex,
        attempt,
        success: false,
        error: message,
      });
      continue;
    }

    const trimmed = ssml.trim();
    const zeroIndex = Math.max(0, chunkIndex - 1);
    const context: BatchChunkContext = {
      zeroIndex,
      chunkIndex,
      chunkLabel,
      attempt,
      task,
      ssml: trimmed,
    };

    chunkContexts.set(zeroIndex, context);
    ssmlChunks[zeroIndex] = trimmed;
    pendingSeed.push(zeroIndex);

    await writeJsonFile(task.audioStatusFilePath, {
      status: "in-progress",
      attempt,
      updatedAt: new Date().toISOString(),
      message: "Audio batch generation started.",
    });
  }

  if (!chunkContexts.size) {
    return initialFailures;
  }

  let pendingIndexes = pendingSeed.slice();
  const chunkResults = new Map<number, ChunkAudioJobResult>();
  let attempt = 0;

  while (pendingIndexes.length && attempt < maxAttempts) {
    attempt += 1;
    const sortedPending = [...pendingIndexes].sort((a, b) => a - b);

    try {
      const attemptResult = await runWithGeminiClient((client) =>
        runBatchAttempt(client, {
          ssmlChunks,
          chunkIndexes: sortedPending,
          voiceName: voice,
          jobLabel,
          pollIntervalMs: pollInterval,
          maxWaitMs,
          attempt,
          totalAttempts: maxAttempts,
          jobId: options?.jobId,
          totalChunks,
        })
      );

      const { successes, failedIndexes } = analyzeBatchResponses(
        attemptResult.responses,
        sortedPending,
        totalChunks,
        jobLabel
      );

      await Promise.all(
        Array.from(successes.entries()).map(async ([zeroIndex, audio]) => {
          const context = chunkContexts.get(zeroIndex);
          if (!context) {
            console.warn(
              `${jobLabel}Received audio for unknown chunk index ${zeroIndex + 1}.`
            );
            return;
          }

          const persisted = await persistBatchChunkAudio(
            context,
            audio,
            jobLabel
          );
          chunkResults.set(context.chunkIndex, persisted);
          chunkContexts.delete(zeroIndex);
        })
      );

      const failedSet = new Set<number>(failedIndexes);

      if (attemptResult.state !== JobState.JOB_STATE_SUCCEEDED) {
        console.warn(
          `${jobLabel}Batch job state ${attemptResult.state} indicates incomplete synthesis for attempt ${attempt}/${maxAttempts}.`
        );
        sortedPending.forEach((index) => failedSet.add(index));
      }

      pendingIndexes = sortedPending.filter((index) => failedSet.has(index));

      if (pendingIndexes.length && attempt < maxAttempts) {
        console.warn(
          `${jobLabel}${pendingIndexes.length} chunk(s) still pending after attempt ${attempt}/${maxAttempts}. Retrying in ${retryDelayMs}ms.`
        );
        await delay(retryDelayMs);
      }
    } catch (error) {
      console.error(
        `${jobLabel}Batch attempt ${attempt}/${maxAttempts} failed.`,
        error
      );

      if (attempt >= maxAttempts) {
        break;
      }

      console.log(
        `${jobLabel}Retrying ${pendingIndexes.length} chunk(s) after ${retryDelayMs}ms.`
      );
      await delay(retryDelayMs);
    }
  }

  if (pendingIndexes.length) {
    const failureMessage = `${jobLabel}Batch synthesis failed after ${attempt} attempt(s). Missing chunk indexes: ${formatChunkList(
      pendingIndexes
    )}.`;

    await Promise.all(
      pendingIndexes.map(async (zeroIndex) => {
        const context = chunkContexts.get(zeroIndex);
        if (!context) {
          return;
        }
        const failureResult = await markBatchChunkFailure(
          context,
          failureMessage
        );
        chunkResults.set(context.chunkIndex, failureResult);
        chunkContexts.delete(zeroIndex);
      })
    );
  }

  const combinedResults = [
    ...initialFailures,
    ...Array.from(chunkResults.values()),
  ];

  if (combinedResults.length !== chunkTasks.length) {
    const missing = chunkTasks
      .map((task) => task.chunkIndex)
      .filter(
        (chunkIndex) =>
          !combinedResults.some((result) => result.chunkIndex === chunkIndex)
      );
    if (missing.length) {
      console.warn(
        `${jobLabel}Batch synthesis completed with missing chunk result(s): ${missing.join(
          ", "
        )}.`
      );
    }
  }

  return combinedResults;
}

interface BatchAttemptContext {
  ssmlChunks: string[];
  chunkIndexes: number[];
  voiceName: string;
  jobLabel: string;
  pollIntervalMs: number;
  maxWaitMs: number;
  attempt: number;
  totalAttempts: number;
  jobId?: string;
  totalChunks: number;
}

interface BatchAttemptResult {
  responses: InlinedResponse[];
  state: JobState;
}

async function runBatchAttempt(
  client: GoogleGenAI,
  context: BatchAttemptContext
): Promise<BatchAttemptResult> {
  const {
    ssmlChunks,
    chunkIndexes,
    voiceName,
    jobLabel,
    pollIntervalMs,
    maxWaitMs,
    attempt,
    totalAttempts,
    jobId,
  } = context;

  if (!chunkIndexes.length) {
    throw new Error("Batch attempt invoked without chunk indexes.");
  }

  console.log(
    `${jobLabel}Batch attempt ${attempt}/${totalAttempts} queuing ${chunkIndexes.length} chunk(s).`
  );

  const inlineRequests = createInlineRequests(ssmlChunks, chunkIndexes, voiceName);
  const quotaReservation = batchQuota.reserve(chunkIndexes.length, jobLabel);

  try {
    const displayName = createDisplayName(jobId, attempt);
    const batchJob = await client.batches.create({
      model: MODEL_ID,
      src: inlineRequests,
      config: { displayName },
    });

    if (!batchJob.name) {
      throw new Error("Gemini did not return a batch job name.");
    }

    quotaReservation.commit();

    console.log(
      `${jobLabel}Batch job ${batchJob.name} created (${displayName}). Polling every ${pollIntervalMs}ms.`
    );

    const completedJob = await pollBatchJob(
      client,
      batchJob.name,
      jobLabel,
      pollIntervalMs,
      maxWaitMs
    );

    const responses = completedJob.dest?.inlinedResponses ?? [];
    if (!responses.length) {
      if (completedJob.dest?.fileName) {
        throw new Error(
          `${jobLabel}Batch job ${batchJob.name} produced a file output (${completedJob.dest.fileName}) instead of inline responses.`
        );
      }
      throw new Error(
        `${jobLabel}Batch job ${batchJob.name} returned no inline responses.`
      );
    }

    return {
      responses,
      state: completedJob.state ?? JobState.JOB_STATE_UNSPECIFIED,
    };
  } catch (error) {
    quotaReservation.release();
    throw error;
  }
}

function analyzeBatchResponses(
  responses: InlinedResponse[],
  expectedIndexes: number[],
  totalChunks: number,
  jobLabel: string
): {
  successes: Map<number, AudioChunk>;
  failedIndexes: number[];
} {
  const successes = new Map<number, AudioChunk>();
  const failed = new Set<number>();
  const seenIndexes = new Set<number>();

  responses.forEach((response, responseIndex) => {
    const chunkIndex = extractChunkIndex(response);
    if (chunkIndex === undefined) {
      console.warn(
        `${jobLabel}Inline response ${responseIndex + 1}/${
          responses.length
        } missing chunk metadata; scheduling retry.`
      );
      return;
    }

    seenIndexes.add(chunkIndex);

    if (response.error) {
      const details =
        response.error.message ??
        response.error.details?.join(", ") ??
        "Unknown error";
      console.error(
        `${jobLabel}Chunk ${chunkIndex + 1}/${totalChunks} failed: ${details}`
      );
      failed.add(chunkIndex);
      return;
    }

    const audio = extractAudioFromResponse(
      response.response,
      chunkIndex + 1,
      totalChunks,
      jobLabel
    );

    if (audio) {
      successes.set(chunkIndex, audio);
    } else {
      failed.add(chunkIndex);
    }
  });

  expectedIndexes.forEach((chunkIndex) => {
    if (!seenIndexes.has(chunkIndex)) {
      failed.add(chunkIndex);
      console.warn(
        `${jobLabel}Chunk ${chunkIndex + 1}/${totalChunks} missing from inline responses; scheduling retry.`
      );
    }
  });

  return { successes, failedIndexes: Array.from(failed) };
}

function createInlineRequests(
  allChunks: string[],
  chunkIndexes: number[],
  voiceName: string
): InlinedRequest[] {
  return chunkIndexes.map((chunkIndex) => {
    const chunk = allChunks[chunkIndex];
    if (typeof chunk !== "string") {
      throw new Error(`Missing SSML chunk at index ${chunkIndex}.`);
    }

    return {
      contents: [
        {
          role: "user" as const,
          parts: [{ text: chunk }],
        },
      ],
      metadata: { chunkIndex: `${chunkIndex}` },
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
    };
  });
}

async function pollBatchJob(
  client: GoogleGenAI,
  jobName: string,
  jobLabel: string,
  pollIntervalMs: number,
  maxWaitMs: number
): Promise<BatchJob> {
  const startTime = Date.now();
  let lastLoggedState: JobState | undefined;

  while (true) {
    const job = await client.batches.get({ name: jobName });
    const state = job.state ?? JobState.JOB_STATE_UNSPECIFIED;

    if (state !== lastLoggedState) {
      console.log(`${jobLabel}Batch job ${jobName} state: ${state}.`);
      lastLoggedState = state;
    }

    if (TERMINAL_STATES.has(state)) {
      return job;
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > maxWaitMs) {
      throw new Error(
        `${jobLabel}Timed out after ${Math.round(
          elapsed / 60000
        )} minute(s) waiting for batch job ${jobName}.`
      );
    }

    await delay(pollIntervalMs);
  }
}

function extractAudioFromResponse(
  response: GenerateContentResponse | undefined,
  chunkNumber: number,
  totalChunks: number,
  jobLabel: string
): AudioChunk | undefined {
  if (!response) {
    console.warn(
      `${jobLabel}Missing response payload for chunk ${chunkNumber}/${totalChunks}.`
    );
    return undefined;
  }

  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const base64Segments: string[] = [];
  let mimeType: string | undefined;

  for (const part of parts) {
    const inlineData = (part as InlineDataPart).inlineData;
    if (!inlineData) {
      continue;
    }

    if (inlineData.data) {
      base64Segments.push(inlineData.data);
    }

    if (inlineData.mimeType) {
      mimeType = inlineData.mimeType;
    }
  }

  if (!base64Segments.length) {
    console.warn(
      `${jobLabel}Chunk ${chunkNumber}/${totalChunks} response lacked inline audio data.`
    );
    return undefined;
  }

  console.log(
    `${jobLabel}Chunk ${chunkNumber}/${totalChunks} returned audio (${
      mimeType ?? "audio/wav"
    }).`
  );

  const combinedBase64 = base64Segments.join("");
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

async function persistBatchChunkAudio(
  context: BatchChunkContext,
  audio: AudioChunk,
  jobLabel: string
): Promise<ChunkAudioJobResult> {
  const extension = mime.getExtension(audio.mimeType) ?? "wav";
  const audioFileName = `chunk-${context.chunkIndex}.${extension}`;
  const audioFilePath = path.join(context.task.chunkDir, audioFileName);

  await writeFile(audioFilePath, audio.buffer);

  await writeJsonFile(context.task.audioMetadataFilePath, {
    chunkIndex: context.chunkIndex,
    attempt: context.attempt,
    mimeType: audio.mimeType,
    fileName: audioFileName,
    updatedAt: new Date().toISOString(),
  });

  await writeJsonFile(context.task.audioStatusFilePath, {
    status: "success",
    attempt: context.attempt,
    updatedAt: new Date().toISOString(),
    message: `Audio chunk saved (${audio.mimeType}).`,
  });

  console.log(
    `${jobLabel}Chunk ${context.chunkLabel} saved to ${audioFilePath} (${audio.mimeType}).`
  );

  return {
    chunkIndex: context.chunkIndex,
    attempt: context.attempt,
    success: true,
    audioFilePath,
    mimeType: audio.mimeType,
  };
}

async function markBatchChunkFailure(
  context: BatchChunkContext,
  message: string
): Promise<ChunkAudioJobResult> {
  await writeJsonFile(context.task.audioStatusFilePath, {
    status: "failed",
    attempt: context.attempt,
    updatedAt: new Date().toISOString(),
    message,
  });

  console.error(`${message} (Chunk ${context.chunkLabel}).`);

  return {
    chunkIndex: context.chunkIndex,
    attempt: context.attempt,
    success: false,
    error: message,
  };
}

class DailyBatchQuota {
  private used = 0;
  private windowStart = startOfToday();

  constructor(private readonly limitPerDay: number) {}

  reserve(requestCount: number, jobLabel: string): QuotaReservation {
    if (requestCount <= 0) {
      throw new Error("requestCount must be greater than zero.");
    }

    this.rotateWindow();

    if (this.limitPerDay <= 0) {
      return createNoopReservation();
    }

    if (requestCount > this.limitPerDay) {
      throw new Error(
        `${jobLabel}Cannot queue ${requestCount} chunk(s); daily Batch limit is ${this.limitPerDay}.`
      );
    }

    if (this.used + requestCount > this.limitPerDay) {
      const available = Math.max(0, this.limitPerDay - this.used);
      throw new Error(
        `${jobLabel}Daily Batch quota exceeded (${this.used}/${this.limitPerDay}). ${available} chunk(s) remaining.`
      );
    }

    this.used += requestCount;
    console.log(
      `${jobLabel}Reserved ${requestCount} chunk(s) against daily Batch limit (${this.used}/${this.limitPerDay}).`
    );

    let finalized = false;
    return {
      commit: () => {
        finalized = true;
      },
      release: () => {
        if (!finalized) {
          this.used = Math.max(0, this.used - requestCount);
          finalized = true;
        }
      },
    };
  }

  private rotateWindow(): void {
    const start = startOfToday();
    if (start !== this.windowStart) {
      this.windowStart = start;
      this.used = 0;
    }
  }
}

const batchQuota = new DailyBatchQuota(GEMINI_TTS_REQUESTS_PER_DAY);

function createNoopReservation(): QuotaReservation {
  return {
    commit() {
      /* noop */
    },
    release() {
      /* noop */
    },
  };
}

function startOfToday(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return start.getTime();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createJobLabel(jobId: string | undefined): string {
  if (jobId) {
    return `[Job ${jobId}][BatchTTS] `;
  }

  return "[BatchTTS] ";
}

function createDisplayName(jobId: string | undefined, attempt?: number): string {
  const base = jobId ? `speech-${jobId}` : `speech-${Date.now()}`;
  const suffix = attempt ? `-a${attempt}` : "";
  return `${base}${suffix}`.slice(0, 63);
}

function extractChunkIndex(response: InlinedResponse): number | undefined {
  const metadata = (response as unknown as {
    metadata?: Record<string, unknown>;
  }).metadata;

  if (!metadata) {
    return undefined;
  }

  const raw =
    metadata.chunkIndex ??
    metadata.chunk_index ??
    metadata["chunk-index"] ??
    metadata.index ??
    metadata.chunk;

  if (typeof raw === "number" && Number.isInteger(raw)) {
    return raw;
  }

  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function formatChunkList(indexes: number[]): string {
  return indexes
    .slice()
    .sort((a, b) => a - b)
    .map((value) => `${value + 1}`)
    .join(", ");
}
