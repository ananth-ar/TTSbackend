import path from "node:path";
import { copyFile } from "node:fs/promises";

import { generateSsmlTextFileFromLlm } from "../ssmlConversionService.ts";
import {
  combineChunkAudioFiles,
  synthesizeAudioFromSsmlChunks,
} from "./audioSynthesis.ts";
import {
  prepareRequestLayout,
  writeInputTextSnapshot,
  writeAudioChunksManifestSnapshot,
  persistSsmlChunks,
  updateRequestMetadata,
} from "./storage.ts";
import { verifyChunkAudioFiles } from "./verification.ts";
import type {
  ChunkProcessingState,
  ChunkVerificationJob,
  ProcessTexttoSpeechParams,
  ProcessTexttoSpeechResult,
} from "./types.ts";

const MAX_AUDIO_ATTEMPTS = 3;
const MAX_VERIFICATION_ATTEMPTS = 3;

export async function processTexttoSpeechJob(
  params: ProcessTexttoSpeechParams
): Promise<ProcessTexttoSpeechResult> {
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
      const audioTasks = needsAudio.map((state) => ({
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

function createJobLabel(jobId: string | undefined, phase: string): string {
  if (!jobId) {
    return `[${phase}] `;
  }
  return `[Job ${jobId}][${phase}] `;
}
