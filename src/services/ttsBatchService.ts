import mime from "mime";
import path from "node:path";
import { writeFile } from "node:fs/promises";

import {
  aiClient,
  DEFAULT_VOICE,
  GEMINI_TTS_REQUESTS_PER_DAY,
  MODEL_ID,
  OUTPUT_DIR,
} from "../config.ts";
import { combineAudioChunks, convertBase64ToWav } from "../utils/audio.ts";
import type { AudioChunk } from "../utils/audio.ts";
import { createAudioFileName, ensureDirectory } from "../utils/fs.ts";
import type { PersistedAudio, SynthesizeAudioOptions } from "./ttsService.ts";
import {
  JobState,
  type BatchJob,
  type GenerateContentResponse,
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

interface QuotaReservation {
  commit(): void;
  release(): void;
}

export async function synthesizeAudioFromSsmlChunksBatch(
  ssmlChunks: string[],
  customVoice?: string,
  requestedFileName?: string,
  options?: BatchSynthesizeAudioOptions
): Promise<PersistedAudio> {
  await ensureDirectory(OUTPUT_DIR);

  if (!ssmlChunks.length) {
    throw new Error("No SSML chunks were provided for synthesis.");
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

  console.log(
    `${jobLabel}Starting Gemini Batch synthesis for ${ssmlChunks.length} chunk(s) using voice "${voice}".`
  );

  const totalChunks = ssmlChunks.length;
  const chunkResults = new Map<number, AudioChunk>();
  let pendingIndexes = ssmlChunks.map((_, index) => index);
  let attempt = 0;

  while (pendingIndexes.length) {
    if (attempt >= maxAttempts) {
      throw new Error(
        `${jobLabel}Batch synthesis failed after ${attempt} attempt(s). Missing chunk indexes: ${formatChunkList(pendingIndexes)}.`
      );
    }

    attempt += 1;
    const sortedPending = [...pendingIndexes].sort((a, b) => a - b);

    try {
      const attemptResult = await runBatchAttempt({
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
      });

      const { successes, failedIndexes } = analyzeBatchResponses(
        attemptResult.responses,
        sortedPending,
        totalChunks,
        jobLabel
      );

      successes.forEach((audio, chunkIndex) => {
        chunkResults.set(chunkIndex, audio);
      });

      const failedSet = new Set<number>(failedIndexes);

      if (attemptResult.state !== JobState.JOB_STATE_SUCCEEDED) {
        console.warn(
          `${jobLabel}Batch job state ${attemptResult.state} indicates incomplete synthesis for attempt ${attempt}/${maxAttempts}.`
        );
        sortedPending.forEach((index) => failedSet.add(index));
      }

      pendingIndexes = sortedPending.filter((index) => failedSet.has(index));

      if (pendingIndexes.length) {
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
        throw error;
      }

      console.log(
        `${jobLabel}Retrying ${pendingIndexes.length} chunk(s) after ${retryDelayMs}ms.`
      );
      await delay(retryDelayMs);
    }
  }

  if (chunkResults.size !== totalChunks) {
    throw new Error(
      `${jobLabel}Batch synthesis ended without audio for all chunks (${chunkResults.size}/${totalChunks}).`
    );
  }

  const audioChunks = Array.from(chunkResults.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, chunk]) => chunk);

  const combinedAudio = combineAudioChunks(audioChunks);
  const extension = mime.getExtension(combinedAudio.mimeType) ?? "wav";
  const fileName = createAudioFileName(extension, requestedFileName);
  const filePath = path.join(OUTPUT_DIR, fileName);

  await writeFile(filePath, combinedAudio.buffer);
  console.log(
    `${jobLabel}Batch audio synthesis saved to ${filePath} (${combinedAudio.mimeType}).`
  );

  return { fileName, filePath, mimeType: combinedAudio.mimeType };
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

  const inlineRequests = createInlineRequests(
    ssmlChunks,
    chunkIndexes,
    voiceName
  );
  const quotaReservation = batchQuota.reserve(chunkIndexes.length, jobLabel);

  try {
    const displayName = createDisplayName(jobId, attempt);
    const batchJob = await aiClient.batches.create({
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
  jobName: string,
  jobLabel: string,
  pollIntervalMs: number,
  maxWaitMs: number
): Promise<BatchJob> {
  const startTime = Date.now();
  let lastLoggedState: JobState | undefined;

  while (true) {
    const job = await aiClient.batches.get({ name: jobName });
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

function createDisplayName(
  jobId: string | undefined,
  attempt?: number
): string {
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
