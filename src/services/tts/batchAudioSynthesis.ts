import mime from "mime";
import path from "node:path";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  DEFAULT_VOICE,
  GEMINI_TTS_REQUESTS_PER_DAY,
  MODEL_ID,
  runWithGeminiClient,
} from "../../config.ts";
import { convertBase64ToWav, type AudioChunk } from "../../utils/audio.ts";
import { countTokens } from "../../utils/text.ts";
import { writeJsonFile } from "../../utils/json.ts";
import type {
  ChunkAudioJobResult,
  SsmlChunkTask,
  SynthesizeAudioOptions,
} from "./types.ts";
import { logGeminiRequest, logGeminiResponse } from "./geminiLogger.ts";
import {
  JobState,
  type BatchJob,
  type GenerateContentResponse,
  type GoogleGenAI,
  type InlinedRequest,
  type InlinedResponse,
  type BatchJobSourceUnion,
  type JobError,
} from "@google/genai";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_BATCH_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const INLINE_REQUEST_SIZE_LIMIT_BYTES = 15 * 1024 * 1024; // Stay under 20MB inline cap
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

interface BatchSource {
  mode: "inline" | "file";
  src: BatchJobSourceUnion;
  mapping: number[];
  keyMap?: Map<string, number>;
  cleanup?: () => Promise<void>;
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
  tokenCount: number;
  sizeBytes: number;
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
    const tokenCount = Math.max(1, countTokens(trimmed));
    const sizeBytes = Buffer.byteLength(trimmed, "utf8");
    const context: BatchChunkContext = {
      zeroIndex,
      chunkIndex,
      chunkLabel,
      attempt,
      task,
      ssml: trimmed,
      tokenCount,
      sizeBytes,
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
          chunkContexts,
        })
      );

      const { successes, failures } = analyzeBatchResponses(
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

          await logGeminiResponse({
            mode: "batch",
            label: `batch chunk ${context.chunkLabel}`,
            status: "success",
            tokens: context.tokenCount,
            requestBytes: context.sizeBytes,
            responseBytes: audio.buffer.length,
          });

          const persisted = await persistBatchChunkAudio(
            context,
            audio,
            jobLabel
          );
          chunkResults.set(context.chunkIndex, persisted);
          chunkContexts.delete(zeroIndex);
        })
      );

      const failureReasons = new Map<number, string>(failures);

      sortedPending.forEach((index) => {
        if (successes.has(index)) {
          return;
        }
        if (!failureReasons.has(index)) {
          failureReasons.set(
            index,
            "missing response in attempt"
          );
          console.warn(
            `${jobLabel}Chunk ${index + 1}/${totalChunks} missing from inline responses; scheduling retry.`
          );
        }
      });

      if (attemptResult.state !== JobState.JOB_STATE_SUCCEEDED) {
        console.warn(
          `${jobLabel}Batch job state ${attemptResult.state} indicates incomplete synthesis for attempt ${attempt}/${maxAttempts}.`
        );
        sortedPending.forEach((index) => {
          if (successes.has(index)) {
            return;
          }
          const reason = `job state ${attemptResult.state}`;
          const existing = failureReasons.get(index);
          failureReasons.set(index, existing ? `${existing}; ${reason}` : reason);
        });
      }

      await logBatchFailures(
        failureReasons,
        chunkContexts
      );

      pendingIndexes = sortedPending.filter((index) =>
        failureReasons.has(index)
      );

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
  chunkContexts: Map<number, BatchChunkContext>;
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
    chunkContexts,
  } = context;

  if (!chunkIndexes.length) {
    throw new Error("Batch attempt invoked without chunk indexes.");
  }

  await logBatchChunkRequests(
    chunkIndexes,
    chunkContexts
  );

  console.log(
    `${jobLabel}Batch attempt ${attempt}/${totalAttempts} queuing ${chunkIndexes.length} chunk(s).`
  );

  const quotaReservation = batchQuota.reserve(chunkIndexes.length, jobLabel);
  let source: BatchSource | undefined;

  try {
    source = await prepareBatchSource(
      client,
      ssmlChunks,
      chunkIndexes,
      voiceName,
      jobLabel
    );
    const displayName = createDisplayName(jobId, attempt);
    const batchJob = await client.batches.create({
      model: MODEL_ID,
      src: source.src,
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
    const finalResponses =
      responses.length > 0
        ? responses
        : completedJob.dest?.fileName
        ? await fetchBatchFileResponses(
            client,
            completedJob.dest.fileName,
            source.mapping,
            source.keyMap,
            jobLabel
          )
        : [];

    if (!finalResponses.length) {
      throw new Error(`${jobLabel}Batch job ${batchJob.name} returned no responses.`);
    }

    return {
      responses: finalResponses,
      state: completedJob.state ?? JobState.JOB_STATE_UNSPECIFIED,
    };
  } catch (error) {
    quotaReservation.release();
    await logBatchAttemptError(
      chunkIndexes,
      chunkContexts,
      error
    );
    throw error;
  } finally {
    await source?.cleanup?.();
  }
}

function analyzeBatchResponses(
  responses: InlinedResponse[],
  expectedIndexes: number[],
  totalChunks: number,
  jobLabel: string
): {
  successes: Map<number, AudioChunk>;
  failures: Map<number, string>;
} {
  const successes = new Map<number, AudioChunk>();
  const failures = new Map<number, string>();
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
      failures.set(chunkIndex, details);
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
      failures.set(chunkIndex, "missing inline audio data");
    }
  });

  expectedIndexes.forEach((chunkIndex) => {
    if (!seenIndexes.has(chunkIndex)) {
      failures.set(chunkIndex, "missing response payload");
      console.warn(
        `${jobLabel}Chunk ${chunkIndex + 1}/${totalChunks} missing from inline responses; scheduling retry.`
      );
    }
  });

  return { successes, failures };
}

async function logBatchChunkRequests(
  chunkIndexes: number[],
  chunkContexts: Map<number, BatchChunkContext>
): Promise<void> {
  if (!chunkIndexes.length) {
    return;
  }

  await Promise.all(
    chunkIndexes.map(async (zeroIndex) => {
      const context = chunkContexts.get(zeroIndex);
      if (!context) {
        return;
      }
      await logGeminiRequest({
        mode: "batch",
        label: `batch chunk ${context.chunkLabel}`,
        tokens: context.tokenCount,
        requestBytes: context.sizeBytes,
      });
    })
  );
}

async function logBatchFailures(
  failures: Map<number, string>,
  chunkContexts: Map<number, BatchChunkContext>
): Promise<void> {
  if (!failures.size) {
    return;
  }

  await Promise.all(
    Array.from(failures.entries()).map(async ([zeroIndex, reason]) => {
      const context = chunkContexts.get(zeroIndex);
      const label = context
        ? `batch chunk ${context.chunkLabel}`
        : `batch chunk ${zeroIndex + 1}`;
      await logGeminiResponse({
        mode: "batch",
        label,
        status: "failure",
        tokens: context?.tokenCount,
        requestBytes: context?.sizeBytes,
        error: summarizeError(reason),
      });
    })
  );
}

async function logBatchAttemptError(
  chunkIndexes: number[],
  chunkContexts: Map<number, BatchChunkContext>,
  error: unknown
): Promise<void> {
  const failures = new Map<number, string>();
  const reason = summarizeError(error);
  chunkIndexes.forEach((index) => failures.set(index, reason));

  await logBatchFailures(failures, chunkContexts);
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
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

    const request = createRequestPayload(chunk, voiceName);
    return {
      ...request,
      metadata: { chunkIndex: `${chunkIndex}` },
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

function createRequestPayload(chunk: string, voiceName: string) {
  return {
    contents: [
      {
        role: "user" as const,
        parts: [{ text: chunk }],
      },
    ],
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
}

async function prepareBatchSource(
  client: GoogleGenAI,
  ssmlChunks: string[],
  chunkIndexes: number[],
  voiceName: string,
  jobLabel: string
): Promise<BatchSource> {
  let tempDir: string | undefined;

  const inlineRequests = createInlineRequests(ssmlChunks, chunkIndexes, voiceName);
  const inlineBytes = estimateInlineBytes(inlineRequests);

  if (inlineBytes <= INLINE_REQUEST_SIZE_LIMIT_BYTES) {
    return {
      mode: "inline",
      src: inlineRequests,
      mapping: chunkIndexes,
    };
  }

  try {
    tempDir = await mkdtemp(path.join(tmpdir(), "tts-batch-"));
    const inputPath = path.join(tempDir, "requests.jsonl");
    const keyMap = new Map<string, number>();

    const lines = chunkIndexes.map((chunkIndex) => {
      const chunk = ssmlChunks[chunkIndex];
      if (typeof chunk !== "string") {
        throw new Error(`Missing SSML chunk at index ${chunkIndex}.`);
      }

      const key = `chunk-${chunkIndex + 1}`;
      keyMap.set(key, chunkIndex);

      const request = createRequestPayload(chunk, voiceName);
      return JSON.stringify({ key, request });
    });

    await writeFile(inputPath, lines.join("\n"), { encoding: "utf8" });

    const uploaded = await client.files.upload({
      file: inputPath,
      config: {
        mimeType: "application/jsonl",
        displayName: `tts-batch-${Date.now()}`,
      },
    });

    console.log(
      `${jobLabel}Uploaded batch input file ${uploaded.name} (${lines.length} request(s)); using file-backed Batch job.`
    );

    const cleanup = async () => {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    };

    return {
      mode: "file",
      src: { fileName: uploaded.name, format: "jsonl" },
      mapping: chunkIndexes,
      keyMap,
      cleanup,
    };
  } catch (error) {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
    throw error;
  }
}

async function fetchBatchFileResponses(
  client: GoogleGenAI,
  fileName: string,
  mapping: number[],
  keyMap: Map<string, number> | undefined,
  jobLabel: string
): Promise<InlinedResponse[]> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tts-batch-out-"));
  const downloadPath = path.join(tempDir, "responses.jsonl");

  try {
    await client.files.download({ file: fileName, downloadPath });
    const content = await readFile(downloadPath, { encoding: "utf8" });
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    console.log(
      `${jobLabel}Downloaded batch result file ${fileName} with ${lines.length} line(s).`
    );

    const responses: InlinedResponse[] = [];

    lines.forEach((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        console.warn(`${jobLabel}Skipping unreadable batch response line ${index + 1}.`, error);
        return;
      }

      const chunkIndex = resolveChunkIndexFromLine(parsed, mapping, keyMap, index);
      const { response, error } = normalizeBatchFileRecord(parsed);

      const enriched: InlinedResponse = {};
      if (chunkIndex !== undefined) {
        (enriched as unknown as { metadata?: Record<string, string> }).metadata = {
          chunkIndex: `${chunkIndex}`,
        };
      }
      if (response) {
        enriched.response = response;
      }
      if (error) {
        enriched.error = error;
      }
      responses.push(enriched);
    });

    return responses;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function resolveChunkIndexFromLine(
  parsed: unknown,
  mapping: number[],
  keyMap: Map<string, number> | undefined,
  responseIndex: number
): number | undefined {
  if (parsed && typeof parsed === "object") {
    const keyed = parsed as { key?: unknown };
    if (typeof keyed.key === "string" && keyMap?.has(keyed.key)) {
      return keyMap.get(keyed.key);
    }
  }

  return mapping[responseIndex];
}

function normalizeBatchFileRecord(
  parsed: unknown
): { response?: GenerateContentResponse; error?: JobError } {
  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const record = parsed as Record<string, unknown>;
  const rawResponse = record.response ?? (record.error ? undefined : parsed);
  const rawError = record.error;

  return {
    response: rawResponse as GenerateContentResponse | undefined,
    error: normalizeJobError(rawError),
  };
}

function normalizeJobError(candidate: unknown): JobError | undefined {
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.status === "string"
      ? record.status
      : undefined;
  const details = Array.isArray(record.details)
    ? record.details
        .map((entry) => (typeof entry === "string" ? entry : undefined))
        .filter((entry): entry is string => Boolean(entry))
    : undefined;
  const code = typeof record.code === "number" ? record.code : undefined;

  if (!message && !details?.length && code === undefined) {
    return undefined;
  }

  return { message, details, code };
}

function estimateInlineBytes(requests: InlinedRequest[]): number {
  try {
    return Buffer.byteLength(JSON.stringify(requests), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
