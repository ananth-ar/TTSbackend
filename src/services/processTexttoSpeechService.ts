import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, readdir, rm, copyFile } from "node:fs/promises";

import { OUTPUT_DIR } from "../config.ts";
import { readJsonFile, writeJsonFile } from "../utils/json.ts";
import { ensureDirectory, createAudioFileName, sanitizeRequestedFileName } from "../utils/fs.ts";
import { ssmlToPlainText } from "../utils/ssml.ts";
import { transcribeAndCompareAudio } from "./audioVerificationService.ts";
import { generateSsmlTextFileFromLlm } from "./ssmlConversionService.ts";
import {
  synthesizeAudioFromSsmlChunks,
  combineChunkAudioFiles,
  type ChunkCheckpoint,
  type PersistedAudio,
  type SsmlChunkTask,
} from "./ttsService.ts";

export interface processTexttoSpeechParams {
  text: string;
  voiceName?: string;
  requestedFileName?: string;
  jobId: string;
}

export interface processTexttoSpeechResult {
  ssmlFileName: string;
  audio?: PersistedAudio;
  chunkCount: number;
  requestDirectory: string;
}

const REQUEST_METADATA_FILE = "request.json";
const AUDIO_CHUNKS_MANIFEST = "audio-chunks.json";
const INPUT_TEXT_FILE = "input.txt";

interface RequestMetadata {
  baseName: string;
  finalAudioFileName: string;
  text?: string;
  voiceName?: string;
  chunkCount?: number;
  ssmlFileName?: string;
  createdAt: string;
  updatedAt: string;
  lastJobId?: string;
  lastCheckpoint?: string;
  lastMergeAt?: string;
}

interface AudioChunksManifest {
  updatedAt: string;
  chunkCount: number;
  chunks: string[];
}

interface StatusSnapshot {
  status?: string;
  attempt?: number;
  updatedAt?: string;
  message?: string;
}

interface AudioMetadataSnapshot {
  chunkIndex: number;
  attempt: number;
  mimeType: string;
  fileName: string;
  updatedAt: string;
}

export interface RestartCheckpointBaseParams {
  targetName: string;
  jobId: string;
}

export interface RestartSsmlParams extends RestartCheckpointBaseParams {
  text?: string;
  voiceName?: string;
}

export interface RestartSsmlResult {
  ssmlFileName: string;
  chunkCount: number;
  requestDirectory: string;
  manifestPath: string;
}

export interface RestartChunksParams extends RestartCheckpointBaseParams {
  chunkIndices?: number[];
}

export interface RestartChunksResult {
  chunkIndices: number[];
  totalChunkCount: number;
  requestDirectory: string;
}

export interface RestartAudioParams extends RestartCheckpointBaseParams {
  chunkIndices?: number[];
  voiceName?: string;
  regenerateAll?: boolean;
}

export interface RestartAudioResult {
  totalRequested: number;
  successes: number;
  failures: Array<{ chunkIndex: number; error?: string }>;
}

export interface RestartAccuracyParams extends RestartCheckpointBaseParams {
  chunkIndices?: number[];
}

export interface RestartAccuracyResult {
  totalRequested: number;
  successes: number;
  failures: Array<{ chunkIndex: number; error?: string }>;
}

export interface RestartMergeParams extends RestartCheckpointBaseParams {}

interface ChunkProcessingState {
  checkpoint: ChunkCheckpoint;
  audioAttempts: number;
  verificationAttempts: number;
  audioReady: boolean;
  verified: boolean;
  audioFilePath?: string;
  mimeType?: string;
}

interface RequestLayout {
  baseName: string;
  requestDir: string;
  finalAudioFileName: string;
  finalAudioFilePath: string;
}

interface ChunkVerificationJob {
  checkpoint: ChunkCheckpoint;
  audioFilePath: string;
  mimeType: string;
  attempt: number;
}

interface ChunkVerificationOutcome {
  chunkIndex: number;
  attempt: number;
  success: boolean;
  error?: string;
}

const MAX_AUDIO_ATTEMPTS = 3;
const MAX_VERIFICATION_ATTEMPTS = 3;

export async function processTexttoSpeechJob(
  params: processTexttoSpeechParams
): Promise<processTexttoSpeechResult> {
  const { text, voiceName, requestedFileName, jobId } = params;
  const pipelineLabel = createJobLabel(jobId, "PIPELINE");

  console.log(`${pipelineLabel}Starting processTexttoSpeech pipeline.`);

  const layout = await prepareRequestLayout(requestedFileName);
  await writeInputTextSnapshot(layout.requestDir, text);
  await updateRequestMetadata(layout, {
    text,
    voiceName,
    lastJobId: jobId,
    lastCheckpoint: "request",
  });

  const ssmlResult = await generateSsmlTextFileFromLlm(
    text,
    `${layout.baseName}-ssml`,
    { jobId, destinationDir: layout.requestDir }
  );

  console.log(
    `${pipelineLabel}SSML conversion complete: ${ssmlResult.chunkCount} chunk(s), file ${ssmlResult.filePath}.`
  );

  await writeAudioChunksManifestSnapshot(layout.requestDir, ssmlResult.chunks);
  await updateRequestMetadata(layout, {
    ssmlFileName: ssmlResult.fileName,
    chunkCount: ssmlResult.chunkCount,
    lastCheckpoint: "ssml",
    lastJobId: jobId,
  });

  const checkpoints = await persistSsmlChunks(
    ssmlResult.chunks,
    layout.requestDir,
    pipelineLabel
  );

  await updateRequestMetadata(layout, {
    lastCheckpoint: "chunks",
  });

  const chunkStates = checkpoints.map<ChunkProcessingState>((checkpoint) => ({
    checkpoint,
    audioAttempts: 0,
    verificationAttempts: 0,
    audioReady: false,
    verified: false,
  }));

  await runChunkAudioPipeline(chunkStates, voiceName, jobId);
  await updateRequestMetadata(layout, {
    lastCheckpoint: "audio-verification",
  });

  const orderedChunks = chunkStates
    .slice()
    .sort(
      (left, right) =>
        left.checkpoint.chunkIndex - right.checkpoint.chunkIndex
    )
    .map((state) => {
      if (!state.audioFilePath || !state.mimeType) {
        throw new Error(
          `Chunk ${state.checkpoint.chunkIndex} is missing audio output despite verification success.`
        );
      }
      return { filePath: state.audioFilePath, mimeType: state.mimeType };
    });

  const audio = await combineChunkAudioFiles(
    orderedChunks,
    layout.finalAudioFilePath,
    { jobId }
  );

  const requestScopedFinalPath = path.join(
    layout.requestDir,
    layout.finalAudioFileName
  );
  if (requestScopedFinalPath !== audio.filePath) {
    await copyFile(audio.filePath, requestScopedFinalPath);
  }

  console.log(
    `${pipelineLabel}Pipeline complete. Final audio persisted to ${audio.filePath}.`
  );

  await updateRequestMetadata(layout, {
    lastCheckpoint: "merged",
    lastMergeAt: new Date().toISOString(),
  });

  return {
    ssmlFileName: ssmlResult.fileName,
    chunkCount: checkpoints.length,
    audio,
    requestDirectory: layout.requestDir,
  };
}

export async function restartSsmlCheckpoint(
  params: RestartSsmlParams
): Promise<RestartSsmlResult> {
  const { targetName, text, voiceName, jobId } = params;
  const layout = await resolveExistingRequestLayout(targetName);
  const metadata = await readRequestMetadata(layout);
  const textToUse = text ?? metadata.text;

  if (!textToUse) {
    throw new Error(
      "No source text found for this request. Provide `text` in the payload to regenerate SSML."
    );
  }

  await writeInputTextSnapshot(layout.requestDir, textToUse);

  const ssmlResult = await generateSsmlTextFileFromLlm(
    textToUse,
    `${layout.baseName}-ssml`,
    { jobId, destinationDir: layout.requestDir }
  );

  await writeAudioChunksManifestSnapshot(layout.requestDir, ssmlResult.chunks);
  await updateRequestMetadata(layout, {
    text: textToUse,
    voiceName: voiceName ?? metadata.voiceName,
    ssmlFileName: ssmlResult.fileName,
    chunkCount: ssmlResult.chunkCount,
    lastCheckpoint: "ssml",
    lastJobId: jobId,
  });

  return {
    ssmlFileName: ssmlResult.fileName,
    chunkCount: ssmlResult.chunkCount,
    manifestPath: path.join(layout.requestDir, AUDIO_CHUNKS_MANIFEST),
    requestDirectory: layout.requestDir,
  };
}

export async function restartChunkCheckpoint(
  params: RestartChunksParams
): Promise<RestartChunksResult> {
  const { targetName, chunkIndices, jobId } = params;
  const layout = await resolveExistingRequestLayout(targetName);
  const manifest = await readAudioChunksManifestSnapshot(layout.requestDir);

  if (!manifest?.chunks?.length) {
    throw new Error(
      "No SSML audio chunk manifest found. Run the SSML checkpoint before regenerating chunk directories."
    );
  }

  const filter = validateChunkIndices(manifest.chunkCount, chunkIndices);
  const checkpoints = await persistSsmlChunks(
    manifest.chunks,
    layout.requestDir,
    createJobLabel(jobId, "CHUNKS"),
    { chunkFilter: filter }
  );

  await updateRequestMetadata(layout, {
    chunkCount: manifest.chunkCount,
    lastCheckpoint: "chunks",
    lastJobId: jobId,
  });

  return {
    chunkIndices: checkpoints.map((checkpoint) => checkpoint.chunkIndex),
    totalChunkCount: manifest.chunkCount,
    requestDirectory: layout.requestDir,
  };
}

export async function restartAudioCheckpoint(
  params: RestartAudioParams
): Promise<RestartAudioResult> {
  const { targetName, chunkIndices, regenerateAll, voiceName, jobId } = params;
  const layout = await resolveExistingRequestLayout(targetName);
  const metadata = await readRequestMetadata(layout);
  const chunkStates = await loadChunkProcessingStates(layout.requestDir);

  if (!chunkStates.length) {
    throw new Error("No chunk checkpoints are available for this request.");
  }

  const totalChunks = chunkStates.length;
  const filter = validateChunkIndices(totalChunks, chunkIndices);
  let targets: ChunkProcessingState[];

  if (filter) {
    const filterSet = new Set(filter);
    targets = chunkStates.filter((state) =>
      filterSet.has(state.checkpoint.chunkIndex)
    );
  } else if (regenerateAll) {
    targets = chunkStates;
  } else {
    targets = chunkStates.filter((state) => !state.audioReady);
  }

  if (!targets.length) {
    throw new Error(
      "No chunk checkpoints matched the selection for audio regeneration."
    );
  }

  const tasks: SsmlChunkTask[] = targets.map((state) => ({
    ...state.checkpoint,
    attempt: state.audioAttempts + 1,
  }));

  const results = await synthesizeAudioFromSsmlChunks(
    tasks,
    voiceName ?? metadata.voiceName,
    { jobId, totalChunkCount: totalChunks }
  );

  const successes = results.filter((result) => result.success).length;
  const failures = results
    .filter((result) => !result.success)
    .map((result) => ({
      chunkIndex: result.chunkIndex,
      error: result.error,
    }));

  await updateRequestMetadata(layout, {
    voiceName: voiceName ?? metadata.voiceName,
    lastCheckpoint: "audio",
    lastJobId: jobId,
  });

  return {
    totalRequested: results.length,
    successes,
    failures,
  };
}

export async function restartAccuracyCheckpoint(
  params: RestartAccuracyParams
): Promise<RestartAccuracyResult> {
  const { targetName, chunkIndices, jobId } = params;
  const layout = await resolveExistingRequestLayout(targetName);
  const chunkStates = await loadChunkProcessingStates(layout.requestDir);

  if (!chunkStates.length) {
    throw new Error("No chunk checkpoints are available for this request.");
  }

  const totalChunks = chunkStates.length;
  const filter = validateChunkIndices(totalChunks, chunkIndices);
  let targets: ChunkProcessingState[];

  if (filter) {
    const filterSet = new Set(filter);
    targets = chunkStates.filter((state) =>
      filterSet.has(state.checkpoint.chunkIndex)
    );
  } else {
    targets = chunkStates.filter(
      (state) => state.audioReady && !state.verified
    );
  }

  if (!targets.length) {
    throw new Error(
      "No chunk checkpoints matched the selection for accuracy verification."
    );
  }

  const jobs: ChunkVerificationJob[] = targets.map((state) => {
    if (!state.audioFilePath) {
      throw new Error(
        `Chunk ${state.checkpoint.chunkIndex} is missing an audio file. Run the audio checkpoint first.`
      );
    }
    return {
      checkpoint: state.checkpoint,
      audioFilePath: state.audioFilePath,
      mimeType: state.mimeType ?? "audio/wav",
      attempt: state.verificationAttempts + 1,
    };
  });

  const outcomes = await verifyChunkAudioFiles(
    jobs,
    createJobLabel(jobId, "VERIFY")
  );

  const successes = outcomes.filter((outcome) => outcome.success).length;
  const failures = outcomes
    .filter((outcome) => !outcome.success)
    .map((outcome) => ({
      chunkIndex: outcome.chunkIndex,
      error: outcome.error,
    }));

  await updateRequestMetadata(layout, {
    lastCheckpoint: "accuracy",
    lastJobId: jobId,
  });

  return {
    totalRequested: outcomes.length,
    successes,
    failures,
  };
}

export async function restartMergeCheckpoint(
  params: RestartMergeParams
): Promise<PersistedAudio> {
  const { targetName, jobId } = params;
  const layout = await resolveExistingRequestLayout(targetName);
  const chunkStates = await loadChunkProcessingStates(layout.requestDir);

  if (!chunkStates.length) {
    throw new Error("No chunk checkpoints are available for this request.");
  }

  const incomplete = chunkStates.filter((state) => !state.verified);
  if (incomplete.length) {
    throw new Error(
      `All chunks must pass accuracy verification before merging. Pending chunk(s): ${incomplete
        .map((state) => state.checkpoint.chunkIndex)
        .join(", ")}.`
    );
  }

  const chunkFiles = chunkStates.map((state) => {
    if (!state.audioFilePath || !state.mimeType) {
      throw new Error(
        `Chunk ${state.checkpoint.chunkIndex} is missing audio metadata.`
      );
    }
    return {
      filePath: state.audioFilePath,
      mimeType: state.mimeType,
    };
  });

  const audio = await combineChunkAudioFiles(
    chunkFiles,
    layout.finalAudioFilePath,
    { jobId }
  );

  const requestScopedFinalPath = path.join(
    layout.requestDir,
    layout.finalAudioFileName
  );
  if (requestScopedFinalPath !== audio.filePath) {
    await copyFile(audio.filePath, requestScopedFinalPath);
  }

  await updateRequestMetadata(layout, {
    lastCheckpoint: "merged",
    lastMergeAt: new Date().toISOString(),
    lastJobId: jobId,
  });

  return audio;
}

async function runChunkAudioPipeline(
  chunkStates: ChunkProcessingState[],
  voiceName: string | undefined,
  jobId: string
): Promise<void> {
  const jobLabel = createJobLabel(jobId, "PIPELINE");
  const chunkCount = chunkStates.length;
  const chunkMap = new Map<number, ChunkProcessingState>();
  chunkStates.forEach((state) =>
    chunkMap.set(state.checkpoint.chunkIndex, state)
  );

  while (chunkStates.some((state) => !state.verified)) {
    const needsAudio = chunkStates.filter(
      (state) => !state.audioReady && state.audioAttempts < MAX_AUDIO_ATTEMPTS
    );

    if (needsAudio.length) {
      const audioTasks: SsmlChunkTask[] = needsAudio.map((state) => ({
        ...state.checkpoint,
        attempt: state.audioAttempts + 1,
      }));

      const results = await synthesizeAudioFromSsmlChunks(
        audioTasks,
        voiceName,
        { jobId, totalChunkCount: chunkCount }
      );

      results.forEach((result) => {
        const state = chunkMap.get(result.chunkIndex);
        if (!state) {
          return;
        }

        state.audioAttempts = result.attempt;
        state.audioReady = result.success && Boolean(result.audioFilePath);
        state.audioFilePath = result.audioFilePath;
        state.mimeType = result.mimeType;
      });

      const blocked = chunkStates.filter(
        (state) => !state.audioReady && state.audioAttempts >= MAX_AUDIO_ATTEMPTS
      );
      if (blocked.length) {
        throw new Error(
          `${jobLabel}Audio generation failed for chunk(s): ${blocked
            .map((state) => state.checkpoint.chunkIndex)
            .join(", ")} after ${MAX_AUDIO_ATTEMPTS} attempt(s).`
        );
      }

      continue;
    }

    const needsVerification = chunkStates.filter(
      (state) => state.audioReady && !state.verified
    );

    if (!needsVerification.length) {
      break;
    }

    const verificationJobs: ChunkVerificationJob[] = needsVerification.map(
      (state) => ({
        checkpoint: state.checkpoint,
        audioFilePath: state.audioFilePath!,
        mimeType: state.mimeType ?? "audio/wav",
        attempt: state.verificationAttempts + 1,
      })
    );

    const outcomes = await verifyChunkAudioFiles(
      verificationJobs,
      createJobLabel(jobId, "VERIFY")
    );

    outcomes.forEach((outcome) => {
      const state = chunkMap.get(outcome.chunkIndex);
      if (!state) {
        return;
      }

      state.verificationAttempts = outcome.attempt;
      state.verified = outcome.success;
      if (!outcome.success) {
        state.audioReady = false;
        state.audioFilePath = undefined;
        state.mimeType = undefined;
      }
    });

    const verificationBlocked = chunkStates.filter(
      (state) =>
        !state.verified &&
        state.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS
    );

    if (verificationBlocked.length) {
      throw new Error(
        `${jobLabel}Accuracy verification failed repeatedly for chunk(s): ${verificationBlocked
          .map((state) => state.checkpoint.chunkIndex)
          .join(", ")}.`
      );
    }
  }
}

async function prepareRequestLayout(
  requestedFileName?: string
): Promise<RequestLayout> {
  await ensureDirectory(OUTPUT_DIR);
  const sanitized = sanitizeRequestedFileName(requestedFileName);
  const fallbackBase = createAudioFileName("wav").replace(/\.[^.]+$/, "");

  const baseCandidate = sanitized ?? fallbackBase;
  let baseName = baseCandidate;
  let suffix = 1;

  while (
    existsSync(path.join(OUTPUT_DIR, baseName)) ||
    existsSync(path.join(OUTPUT_DIR, `${baseName}.wav`))
  ) {
    baseName = `${baseCandidate}-${suffix}`;
    suffix += 1;
  }

  const requestDir = path.join(OUTPUT_DIR, baseName);
  await ensureDirectory(requestDir);

  return {
    baseName,
    requestDir,
    finalAudioFileName: `${baseName}.wav`,
    finalAudioFilePath: path.join(OUTPUT_DIR, `${baseName}.wav`),
  };
}

async function persistSsmlChunks(
  chunks: string[],
  requestDir: string,
  jobLabel: string,
  options?: { chunkFilter?: number[] }
): Promise<ChunkCheckpoint[]> {
  const checkpoints: ChunkCheckpoint[] = [];
  const filterSet = options?.chunkFilter?.length
    ? new Set(options.chunkFilter)
    : undefined;

  for (const [index, chunk] of chunks.entries()) {
    const chunkIndex = index + 1;
    if (filterSet && !filterSet.has(chunkIndex)) {
      continue;
    }

    const checkpoint = createChunkCheckpoint(requestDir, chunkIndex);
    await rm(checkpoint.chunkDir, { recursive: true, force: true }).catch(
      () => undefined
    );
    await ensureDirectory(checkpoint.chunkDir);
    await writeFile(checkpoint.ssmlFilePath, chunk.trim(), { encoding: "utf8" });

    await initializeCheckpointFiles(checkpoint);
    checkpoints.push(checkpoint);
    console.log(
      `${jobLabel}Persisted SSML chunk ${chunkIndex} to ${checkpoint.ssmlFilePath}.`
    );
  }

  if (!filterSet) {
    await removeObsoleteChunkDirectories(requestDir, chunks.length);
  }

  return checkpoints.sort((a, b) => a.chunkIndex - b.chunkIndex);
}

async function initializeCheckpointFiles(
  checkpoint: ChunkCheckpoint
): Promise<void> {
  const timestamp = new Date().toISOString();
  await writeJsonFile(checkpoint.audioStatusFilePath, {
    status: "pending",
    attempt: 0,
    updatedAt: timestamp,
  });
  await writeJsonFile(checkpoint.accuracyStatusFilePath, {
    status: "pending",
    attempt: 0,
    updatedAt: timestamp,
  });
}

function createChunkCheckpoint(
  requestDir: string,
  chunkIndex: number
): ChunkCheckpoint {
  const chunkDir = path.join(requestDir, `${chunkIndex}`);
  return {
    chunkIndex,
    chunkDir,
    chunkLabel: `Chunk ${chunkIndex}`,
    ssmlFilePath: path.join(chunkDir, `chunk-${chunkIndex}.ssml`),
    textFilePath: path.join(chunkDir, "chunk.txt"),
    audioStatusFilePath: path.join(chunkDir, "audiogen-status.json"),
    audioMetadataFilePath: path.join(chunkDir, "audio-metadata.json"),
    accuracyStatusFilePath: path.join(chunkDir, "accuracy-status.json"),
  };
}

async function removeObsoleteChunkDirectories(
  requestDir: string,
  maxChunkIndex: number
): Promise<void> {
  const entries = await readdir(requestDir, { withFileTypes: true });
  const obsolete = entries.filter(
    (entry) => entry.isDirectory() && Number(entry.name) > maxChunkIndex
  );
  for (const entry of obsolete) {
    const dirPath = path.join(requestDir, entry.name);
    await rm(dirPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function verifyChunkAudioFiles(
  jobs: ChunkVerificationJob[],
  jobLabel: string
): Promise<ChunkVerificationOutcome[]> {
  const results: ChunkVerificationOutcome[] = [];

  for (const job of jobs) {
    const chunkIndex = job.checkpoint.chunkIndex;
    try {
      console.log(
        `${jobLabel}Starting verification for chunk ${chunkIndex}, attempt ${job.attempt}.`
      );
      const expectedText = await ensurePlainTextFile(job.checkpoint);
      const audioBuffer = await readFile(job.audioFilePath);
      const verification = await transcribeAndCompareAudio({
        expectedText,
        audioBuffer,
        fileName: path.basename(job.audioFilePath),
        mimeType: job.mimeType,
      });

      const isSilent = !verification.transcription?.trim();
      const success = verification.success && !isSilent;
      const message = success
        ? `Accuracy matched ${verification.matchPercent}% (threshold ${verification.matchThreshold}%).`
        : createVerificationFailureMessage(
            verification.matchPercent,
            verification.matchThreshold,
            isSilent
          );

      await writeJsonFile(job.checkpoint.accuracyStatusFilePath, {
        status: success ? "success" : "failed",
        attempt: job.attempt,
        updatedAt: new Date().toISOString(),
        matchPercent: verification.matchPercent,
        matchThreshold: verification.matchThreshold,
        transcription: verification.transcription,
        normalizedTranscription: verification.normalizedTranscription,
        providedText: verification.providedText,
        message,
      });

      results.push({
        chunkIndex,
        attempt: job.attempt,
        success,
        error: success ? undefined : message,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Audio verification failed unexpectedly.";
      console.error(
        `${jobLabel}Verification failed for chunk ${chunkIndex}.`,
        error
      );
      await writeJsonFile(job.checkpoint.accuracyStatusFilePath, {
        status: "failed",
        attempt: job.attempt,
        updatedAt: new Date().toISOString(),
        message,
      });

      results.push({
        chunkIndex,
        attempt: job.attempt,
        success: false,
        error: message,
      });
    }
  }

  return results;
}

async function ensurePlainTextFile(
  checkpoint: ChunkCheckpoint
): Promise<string> {
  const ssml = await readFile(checkpoint.ssmlFilePath, { encoding: "utf8" });
  const plain = ssmlToPlainText(ssml);
  await writeFile(checkpoint.textFilePath, `${plain}\n`, { encoding: "utf8" });
  return plain;
}

function createVerificationFailureMessage(
  matchPercent: number,
  matchThreshold: number,
  isSilent: boolean
): string {
  if (isSilent) {
    return "Verification detected silence or empty transcription.";
  }

  return `Verification match ${matchPercent}% below threshold ${matchThreshold}%.`;
}

function createJobLabel(jobId: string | undefined, phase: string): string {
  if (!jobId) {
    return `[${phase}] `;
  }
  return `[Job ${jobId}][${phase}] `;
}

async function writeAudioChunksManifestSnapshot(
  requestDir: string,
  chunks: string[]
): Promise<void> {
  const manifestPath = path.join(requestDir, AUDIO_CHUNKS_MANIFEST);
  const manifest: AudioChunksManifest = {
    updatedAt: new Date().toISOString(),
    chunkCount: chunks.length,
    chunks,
  };
  await writeJsonFile(manifestPath, manifest);
}

async function readAudioChunksManifestSnapshot(
  requestDir: string
): Promise<AudioChunksManifest | undefined> {
  const manifestPath = path.join(requestDir, AUDIO_CHUNKS_MANIFEST);
  return readJsonFile<AudioChunksManifest>(manifestPath);
}

async function writeInputTextSnapshot(
  requestDir: string,
  text: string
): Promise<void> {
  const inputPath = path.join(requestDir, INPUT_TEXT_FILE);
  await writeFile(inputPath, `${text}\n`, { encoding: "utf8" });
}

function getRequestMetadataPath(requestDir: string): string {
  return path.join(requestDir, REQUEST_METADATA_FILE);
}

async function readRequestMetadata(
  layout: RequestLayout
): Promise<RequestMetadata> {
  const metadataPath = getRequestMetadataPath(layout.requestDir);
  const existing = await readJsonFile<RequestMetadata>(metadataPath);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const base: RequestMetadata = {
    baseName: layout.baseName,
    finalAudioFileName: layout.finalAudioFileName,
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonFile(metadataPath, base);
  return base;
}

async function updateRequestMetadata(
  layout: RequestLayout,
  patch: Partial<RequestMetadata>
): Promise<RequestMetadata> {
  const current = await readRequestMetadata(layout);
  const now = new Date().toISOString();
  const updated: RequestMetadata = {
    ...current,
    ...patch,
    baseName: layout.baseName,
    finalAudioFileName: layout.finalAudioFileName,
    createdAt: current.createdAt ?? now,
    updatedAt: now,
  };

  await writeJsonFile(getRequestMetadataPath(layout.requestDir), updated);
  return updated;
}

async function loadChunkCheckpointsFromDisk(
  requestDir: string
): Promise<ChunkCheckpoint[]> {
  const entries = await readdir(requestDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => createChunkCheckpoint(requestDir, Number(entry.name)))
    .sort((left, right) => left.chunkIndex - right.chunkIndex);
}

async function loadChunkProcessingStates(
  requestDir: string
): Promise<ChunkProcessingState[]> {
  const checkpoints = await loadChunkCheckpointsFromDisk(requestDir);
  const states: ChunkProcessingState[] = [];

  for (const checkpoint of checkpoints) {
    const audioStatus =
      (await readJsonFile<StatusSnapshot>(checkpoint.audioStatusFilePath)) ??
      {};
    const accuracyStatus =
      (await readJsonFile<StatusSnapshot>(checkpoint.accuracyStatusFilePath)) ??
      {};
    const audioMetadata =
      await readJsonFile<AudioMetadataSnapshot>(
        checkpoint.audioMetadataFilePath
      );
    const audioFilePath =
      audioMetadata && audioMetadata.fileName
        ? path.join(checkpoint.chunkDir, audioMetadata.fileName)
        : undefined;
    const hasAudioFile =
      Boolean(audioFilePath) && existsSync(audioFilePath as string);

    states.push({
      checkpoint,
      audioAttempts: audioStatus.attempt ?? 0,
      verificationAttempts: accuracyStatus.attempt ?? 0,
      audioReady: Boolean(hasAudioFile),
      verified: accuracyStatus.status === "success",
      audioFilePath: hasAudioFile ? (audioFilePath as string) : undefined,
      mimeType: audioMetadata?.mimeType,
    });
  }

  return states;
}

function normalizeTargetName(targetName: string): string {
  const trimmed = targetName.trim();
  const sanitized = sanitizeRequestedFileName(trimmed);
  if (sanitized) {
    return sanitized;
  }
  const lastSegment = trimmed.replace(/\\/g, "/").split("/").pop() ?? trimmed;
  return lastSegment;
}

async function resolveExistingRequestLayout(
  targetName: string
): Promise<RequestLayout> {
  const normalized = normalizeTargetName(targetName);
  const requestDir = path.join(OUTPUT_DIR, normalized);
  if (!existsSync(requestDir)) {
    throw new Error(
      `Request directory "${normalized}" was not found in ${OUTPUT_DIR}.`
    );
  }

  return {
    baseName: normalized,
    requestDir,
    finalAudioFileName: `${normalized}.wav`,
    finalAudioFilePath: path.join(OUTPUT_DIR, `${normalized}.wav`),
  };
}

function validateChunkIndices(
  totalChunks: number,
  indices?: number[]
): number[] | undefined {
  if (!indices || !indices.length) {
    return undefined;
  }

  const sanitized: number[] = [];
  for (const rawValue of indices) {
    if (!Number.isFinite(rawValue)) {
      throw new Error("Chunk indices must be finite numbers.");
    }
    const value = Math.trunc(rawValue);
    if (value < 1 || value > totalChunks) {
      throw new Error(
        `Chunk index ${value} is outside the range of 1-${totalChunks}.`
      );
    }
    sanitized.push(value);
  }

  return Array.from(new Set(sanitized)).sort((a, b) => a - b);
}
