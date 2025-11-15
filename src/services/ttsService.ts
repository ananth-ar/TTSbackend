import mime from "mime";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import {
  GEMINI_TTS_REQUESTS_PER_MINUTE,
  GEMINI_TTS_TOKENS_PER_MINUTE,
  aiClient,
  DEFAULT_VOICE,
  MODEL_ID,
} from "../config.ts";
import { ensureDirectory } from "../utils/fs.ts";
import type { AudioChunk } from "../utils/audio.ts";
import { combineAudioChunks, convertBase64ToWav } from "../utils/audio.ts";
import { countTokens } from "../utils/text.ts";
import { writeJsonFile } from "../utils/json.ts";

interface InlineDataPart {
  inlineData?: {
    data?: string;
    mimeType?: string;
  };
}

export interface PersistedAudio {
  fileName: string;
  filePath: string;
  mimeType: string;
}

export interface ChunkCheckpoint {
  chunkIndex: number;
  chunkDir: string;
  chunkLabel: string;
  ssmlFilePath: string;
  textFilePath: string;
  audioStatusFilePath: string;
  audioMetadataFilePath: string;
  accuracyStatusFilePath: string;
}

export interface SsmlChunkTask extends ChunkCheckpoint {
  attempt: number;
}

export interface ChunkAudioJobResult {
  chunkIndex: number;
  attempt: number;
  success: boolean;
  audioFilePath?: string;
  mimeType?: string;
  error?: string;
}

export interface SynthesizeAudioOptions {
  jobId?: string;
  totalChunkCount?: number;
}

const REQUEST_WINDOW_MS = 60_000;
const MIN_WAIT_MS = 100;

export async function synthesizeAudioFromSsmlChunks(
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
    `${jobLabel}Starting audio synthesis for ${chunkTasks.length} chunk task(s) using voice "${voice}".`
  );

  const results: ChunkAudioJobResult[] = [];

  for (const task of chunkTasks) {
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
      results.push({
        chunkIndex: chunkNumber,
        attempt: task.attempt,
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
        attempt: task.attempt,
        updatedAt: new Date().toISOString(),
        message,
      });
      results.push({
        chunkIndex: chunkNumber,
        attempt: task.attempt,
        success: false,
        error: message,
      });
      continue;
    }

    const tokensNeeded = Math.max(1, countTokens(ssml));
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
      const chunkAudio = await generateAudioFromSsml(
        ssml,
        voice,
        jobLabel,
        chunkNumber,
        totalChunkCount
      );

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

      results.push({
        chunkIndex: chunkNumber,
        attempt: task.attempt,
        success: true,
        audioFilePath,
        mimeType: chunkAudio.mimeType,
      });
    } catch (error) {
      const message = `${jobLabel}Chunk ${chunkLabel} synthesis failed.`;
      console.error(message, error);
      await writeJsonFile(task.audioStatusFilePath, {
        status: "failed",
        attempt: task.attempt,
        updatedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : message,
      });
      results.push({
        chunkIndex: chunkNumber,
        attempt: task.attempt,
        success: false,
        error: error instanceof Error ? error.message : message,
      });
    }
  }

  return results;
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

async function generateAudioFromSsml(
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

  const response = await aiClient.models.generateContentStream({
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
