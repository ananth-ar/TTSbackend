import path from "node:path";
import { copyFile } from "node:fs/promises";

import { generateSsmlTextFileFromLlm } from "../ssmlConversionService.ts";
import {
  combineChunkAudioFiles,
  synthesizeAudioFromSsmlChunks,
} from "./audioSynthesis.ts";
import {
  getManifestPath,
  loadChunkProcessingStates,
  persistSsmlChunks,
  readAudioChunksManifestSnapshot,
  readRequestMetadata,
  resolveExistingRequestLayout,
  updateRequestMetadata,
  validateChunkIndices,
  writeAudioChunksManifestSnapshot,
  writeInputTextSnapshot,
} from "./storage.ts";
import { verifyChunkAudioFiles } from "./verification.ts";
import type {
  ChunkProcessingState,
  ChunkVerificationJob,
  PersistedAudio,
  RestartAccuracyParams,
  RestartAccuracyResult,
  RestartAudioParams,
  RestartAudioResult,
  RestartChunksParams,
  RestartChunksResult,
  RestartMergeParams,
  RestartSsmlParams,
  RestartSsmlResult,
} from "./types.ts";

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
    manifestPath: getManifestPath(layout.requestDir),
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
  const {
    targetName,
    chunkIndices,
    regenerateAll,
    regenerateOnlyMissing,
    regenerateFailedAccuracyAudios,
    voiceName,
    jobId,
  } = params;
  const layout = await resolveExistingRequestLayout(targetName);
  const metadata = await readRequestMetadata(layout);
  const chunkStates = await loadChunkProcessingStates(layout.requestDir);

  if (!chunkStates.length) {
    throw new Error("No chunk checkpoints are available for this request.");
  }

  const totalChunks = chunkStates.length;
  const filter = validateChunkIndices(totalChunks, chunkIndices);
  const filterSet = filter?.length ? new Set(filter) : undefined;
  const defaultTargets = selectChunkTargets(
    chunkStates,
    filter,
    regenerateAll ?? false,
    (state) => !state.audioReady
  );

  const missingTargets = chunkStates.filter((state) => {
    if (filterSet && !filterSet.has(state.checkpoint.chunkIndex)) {
      return false;
    }
    return !state.audioReady;
  });

  const failedAccuracyTargets =
    regenerateFailedAccuracyAudios && chunkStates.length
      ? chunkStates.filter((state) => {
          if (filterSet && !filterSet.has(state.checkpoint.chunkIndex)) {
            return false;
          }
          return state.accuracyStatus === "failed";
        })
      : [];

  const targets = (() => {
    if (regenerateOnlyMissing) {
      return dedupeChunkTargets([
        ...missingTargets,
        ...(regenerateFailedAccuracyAudios ? failedAccuracyTargets : []),
      ]);
    }

    if (regenerateFailedAccuracyAudios) {
      return dedupeChunkTargets([...defaultTargets, ...failedAccuracyTargets]);
    }

    return defaultTargets;
  })();

  if (!targets.length) {
    throw new Error(
      "No chunk checkpoints matched the selection for audio regeneration."
    );
  }

  const tasks = targets.map((state) => ({
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
  const targets = selectChunkTargets(
    chunkStates,
    filter,
    false,
    (state) => state.audioReady && !state.verified
  );

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

function selectChunkTargets(
  states: ChunkProcessingState[],
  filter: number[] | undefined,
  forceAll: boolean,
  predicate: (state: ChunkProcessingState) => boolean
): ChunkProcessingState[] {
  if (filter?.length) {
    const filterSet = new Set(filter);
    return states.filter((state) => filterSet.has(state.checkpoint.chunkIndex));
  }

  if (forceAll) {
    return states;
  }

  return states.filter(predicate);
}

function dedupeChunkTargets(
  candidates: ChunkProcessingState[]
): ChunkProcessingState[] {
  const byChunkIndex = new Map<number, ChunkProcessingState>();
  candidates.forEach((state) =>
    byChunkIndex.set(state.checkpoint.chunkIndex, state)
  );

  return Array.from(byChunkIndex.values()).sort(
    (left, right) => left.checkpoint.chunkIndex - right.checkpoint.chunkIndex
  );
}

function createJobLabel(jobId: string | undefined, phase: string): string {
  if (!jobId) {
    return `[${phase}] `;
  }
  return `[Job ${jobId}][${phase}] `;
}
