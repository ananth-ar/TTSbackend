import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";

import {
  restartAccuracyCheckpoint,
  restartAudioCheckpoint,
  restartChunkCheckpoint,
  restartMergeCheckpoint,
  restartSsmlCheckpoint,
} from "../../services/processTexttoSpeechService.ts";
import {
  loadChunkProcessingStates,
  readAudioChunksManifestSnapshot,
  readRequestMetadata,
  resolveExistingRequestLayout,
} from "../../services/tts/storage.ts";
import type { ChunkProcessingState } from "../../services/tts/types.ts";

const router = Router();

// Payload: { targetName: string, text?: string, voiceName?: string }
router.post("/tts/restart/ssml", (req: Request, res: Response) => {
  const jobId = randomUUID();
  let payload:
    | {
        targetName: string;
        text?: string;
        voiceName?: string;
      }
    | undefined;
  try {
    payload = {
      targetName: requireTargetName(req.body),
      text: parseOptionalString(req.body?.text, "`text`"),
      voiceName: parseOptionalString(req.body?.voiceName, "`voiceName`"),
    };
  } catch (error) {
    handleRestartError(res, "ssml", jobId, error);
    return;
  }

  if (!payload) {
    return;
  }

  const { targetName, text, voiceName } = payload;

  res.status(202).json({
    jobId,
    status: "processing",
    message: "SSML regeneration scheduled.",
  });

  restartSsmlCheckpoint({
    targetName,
    text,
    voiceName,
    jobId,
  })
    .then((result) => {
      console.log(
        `[Job ${jobId}][ssml] Restart completed. Check ${result.requestDirectory} for updated files.`
      );
    })
    .catch((error) => {
      console.error(
        `[Job ${jobId}][ssml] checkpoint restart failed after acknowledgement.`,
        error
      );
    });
});

// Payload: { targetName: string, chunkIndices?: number[] }
router.post("/tts/restart/chunks", async (req: Request, res: Response) => {
  const jobId = randomUUID();
  try {
    const targetName = requireTargetName(req.body);
    const chunkIndices = parseChunkIndices(req.body?.chunkIndices);

    const result = await restartChunkCheckpoint({
      targetName,
      chunkIndices,
      jobId,
    });

    res.json({
      jobId,
      requestDirectory: result.requestDirectory,
      regeneratedChunks: result.chunkIndices,
      totalChunkCount: result.totalChunkCount,
    });
  } catch (error) {
    handleRestartError(res, "chunks", jobId, error);
  }
});

// Payload: { targetName: string, text?: string, voiceName?: string }
router.post(
  "/tts/restart/full-check-restart",
  async (req: Request, res: Response) => {
    const jobId = randomUUID();
    let payload:
      | {
          targetName: string;
          text?: string;
          voiceName?: string;
        }
      | undefined;
    try {
      payload = {
        targetName: requireTargetName(req.body),
        text: parseOptionalString(req.body?.text, "`text`"),
        voiceName: parseOptionalString(req.body?.voiceName, "`voiceName`"),
      };
      await resolveExistingRequestLayout(payload.targetName);
    } catch (error) {
      handleRestartError(res, "full-check", jobId, error);
      return;
    }

    if (!payload) {
      return;
    }

    res.status(202).json({
      jobId,
      status: "processing",
      message: "Full checkpoint restart scheduled.",
    });

    runFullCheckpointRestart({
      ...payload,
      jobId,
    })
      .then(() => {
        console.log(
          `[Job ${jobId}][full-check] Full checkpoint restart flow completed.`
        );
      })
      .catch((error) => {
        console.error(
          `[Job ${jobId}][full-check] Restart flow failed after acknowledgement.`,
          error
        );
      });
  }
);

// Payload: { targetName: string, chunkIndices?: number[], voiceName?: string, regenerateAll?: boolean, regenerateOnlyMissing?: boolean, regenerateFailedAccuracyAudios?: boolean }
router.post("/tts/restart/audio", (req: Request, res: Response) => {
  const jobId = randomUUID();
  let payload:
    | {
        targetName: string;
        chunkIndices?: number[];
        voiceName?: string;
        regenerateAll?: boolean;
        regenerateOnlyMissing?: boolean;
        regenerateFailedAccuracyAudios?: boolean;
      }
    | undefined;
  try {
    payload = {
      targetName: requireTargetName(req.body),
      chunkIndices: parseChunkIndices(req.body?.chunkIndices),
      voiceName: parseOptionalString(req.body?.voiceName, "`voiceName`"),
      regenerateAll: parseOptionalBoolean(
        req.body?.regenerateAll,
        "`regenerateAll`"
      ),
      regenerateOnlyMissing: parseOptionalBoolean(
        req.body?.regenerateOnlyMissing,
        "`regenerateOnlyMissing`"
      ),
      regenerateFailedAccuracyAudios: parseOptionalBoolean(
        req.body?.regenerateFailedAccuracyAudios,
        "`regenerateFailedAccuracyAudios`"
      ),
    };
  } catch (error) {
    handleRestartError(res, "audio", jobId, error);
    return;
  }

  if (!payload) {
    return;
  }

  const {
    targetName,
    chunkIndices,
    voiceName,
    regenerateAll,
    regenerateOnlyMissing,
    regenerateFailedAccuracyAudios,
  } = payload;

  res.status(202).json({
    jobId,
    status: "processing",
    message: "Audio chunk regeneration scheduled.",
  });

  restartAudioCheckpoint({
    targetName,
    chunkIndices,
    regenerateAll: regenerateAll ?? false,
    regenerateOnlyMissing: regenerateOnlyMissing ?? false,
    regenerateFailedAccuracyAudios: regenerateFailedAccuracyAudios ?? false,
    voiceName,
    jobId,
  })
    .then((result) => {
      console.log(
        `[Job ${jobId}][audio] Restart requested for ${result.totalRequested} chunk(s). Successes: ${result.successes}, Failures: ${result.failures.length}.`
      );
    })
    .catch((error) => {
      console.error(
        `[Job ${jobId}][audio] checkpoint restart failed after acknowledgement.`,
        error
      );
    });
});

// Payload: { targetName: string, chunkIndices?: number[] }
router.post("/tts/restart/accuracy", (req: Request, res: Response) => {
  const jobId = randomUUID();
  let payload:
    | {
        targetName: string;
        chunkIndices?: number[];
      }
    | undefined;
  try {
    payload = {
      targetName: requireTargetName(req.body),
      chunkIndices: parseChunkIndices(req.body?.chunkIndices),
    };
  } catch (error) {
    handleRestartError(res, "accuracy", jobId, error);
    return;
  }

  if (!payload) {
    return;
  }

  const { targetName, chunkIndices } = payload;

  res.status(202).json({
    jobId,
    status: "processing",
    message: "Accuracy verification scheduled.",
  });

  restartAccuracyCheckpoint({
    targetName,
    chunkIndices,
    jobId,
  })
    .then((result) => {
      console.log(
        `[Job ${jobId}][accuracy] Restart requested for ${result.totalRequested} chunk(s). Successes: ${result.successes}, Failures: ${result.failures.length}.`
      );
    })
    .catch((error) => {
      console.error(
        `[Job ${jobId}][accuracy] checkpoint restart failed after acknowledgement.`,
        error
      );
    });
});

// Payload: { targetName: string }
router.post("/tts/restart/merge", async (req: Request, res: Response) => {
  const jobId = randomUUID();
  try {
    const targetName = requireTargetName(req.body);
    const audio = await restartMergeCheckpoint({
      targetName,
      jobId,
    });

    res.json({
      jobId,
      fileName: audio.fileName,
      filePath: audio.filePath,
      mimeType: audio.mimeType,
    });
  } catch (error) {
    handleRestartError(res, "merge", jobId, error);
  }
});

async function runFullCheckpointRestart(params: {
  targetName: string;
  text?: string;
  voiceName?: string;
  jobId: string;
}): Promise<void> {
  const { targetName, text, voiceName, jobId } = params;
  const jobLabel = `[Job ${jobId}][full-check]`;
  const layout = await resolveExistingRequestLayout(targetName);
  let metadata = await readRequestMetadata(layout);
  let manifest = await readAudioChunksManifestSnapshot(layout.requestDir);
  let voiceForAudio = voiceName ?? metadata.voiceName;

  if (!manifest?.chunks?.length) {
    console.log(
      `${jobLabel} No SSML manifest found. Restarting SSML checkpoint.`
    );
    await restartSsmlCheckpoint({
      targetName,
      text,
      voiceName: voiceForAudio,
      jobId,
    });
    manifest = await readAudioChunksManifestSnapshot(layout.requestDir);
    metadata = await readRequestMetadata(layout);
    voiceForAudio = voiceName ?? metadata.voiceName;
  }

  let chunkStates: ChunkProcessingState[] = manifest
    ? await loadChunkProcessingStates(layout.requestDir)
    : [];

  if (
    !chunkStates.length ||
    (manifest && chunkStates.length < manifest.chunkCount)
  ) {
    console.log(
      `${jobLabel} Regenerating chunk checkpoints before continuing.`
    );
    await restartChunkCheckpoint({
      targetName,
      jobId,
    });
    chunkStates = await loadChunkProcessingStates(layout.requestDir);
    manifest = await readAudioChunksManifestSnapshot(layout.requestDir);
  }

  const audioTargetIndices = dedupeChunkIndices(
    chunkStates
      .filter(
        (state) => !state.audioReady || state.accuracyStatus === "failed"
      )
      .map((state) => state.checkpoint.chunkIndex)
  );

  if (audioTargetIndices.length) {
    console.log(
      `${jobLabel} Regenerating audio for chunk(s): ${audioTargetIndices.join(
        ", "
      )}.`
    );
    await restartAudioCheckpoint({
      targetName,
      chunkIndices: audioTargetIndices,
      regenerateOnlyMissing: true,
      regenerateFailedAccuracyAudios: true,
      voiceName: voiceForAudio,
      jobId,
    });
    chunkStates = await loadChunkProcessingStates(layout.requestDir);
    metadata = await readRequestMetadata(layout);
    voiceForAudio = voiceName ?? metadata.voiceName;
  }

  const verificationTargets = dedupeChunkIndices(
    chunkStates
      .filter((state) => state.audioReady && !state.verified)
      .map((state) => state.checkpoint.chunkIndex)
  );

  if (verificationTargets.length) {
    console.log(
      `${jobLabel} Running accuracy verification for chunk(s): ${verificationTargets.join(
        ", "
      )}.`
    );
    await restartAccuracyCheckpoint({
      targetName,
      chunkIndices: verificationTargets,
      jobId,
    });
    chunkStates = await loadChunkProcessingStates(layout.requestDir);
  }

  const allVerified =
    chunkStates.length > 0 && chunkStates.every((state) => state.verified);

  if (allVerified) {
    console.log(`${jobLabel} All chunks verified. Merging final audio.`);
    await restartMergeCheckpoint({
      targetName,
      jobId,
    });
    return;
  }

  const pending = chunkStates
    .filter((state) => !state.verified)
    .map((state) => state.checkpoint.chunkIndex);
  console.warn(
    `${jobLabel} Skipping merge; pending or failed verification for chunk(s): ${pending.join(
      ", "
    )}.`
  );
}

function dedupeChunkIndices(indices: number[]): number[] {
  return Array.from(new Set(indices)).sort((left, right) => left - right);
}

export default router;

class PayloadValidationError extends Error {}

function requireTargetName(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new PayloadValidationError("`targetName` is required.");
  }

  const value = (payload as { targetName?: unknown }).targetName;
  if (typeof value !== "string" || !value.trim()) {
    throw new PayloadValidationError("`targetName` is required.");
  }

  return value.trim();
}

function parseOptionalString(
  value: unknown,
  fieldLabel: string
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new PayloadValidationError(`${fieldLabel} must be a string.`);
  }

  return value;
}

function parseChunkIndices(value: unknown): number[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new PayloadValidationError("`chunkIndices` must be an array.");
  }

  if (!value.every((entry) => typeof entry === "number")) {
    throw new PayloadValidationError("`chunkIndices` entries must be numbers.");
  }

  return value as number[];
}

function parseOptionalBoolean(
  value: unknown,
  fieldLabel: string
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new PayloadValidationError(`${fieldLabel} must be a boolean.`);
  }

  return value;
}

function handleRestartError(
  res: Response,
  stage: string,
  jobId: string,
  error: unknown
): void {
  console.error(`[Job ${jobId}][${stage}] checkpoint restart failed.`, error);
  if (error instanceof PayloadValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }

  if (error instanceof Error) {
    res.status(400).json({ error: error.message });
    return;
  }

  res.status(500).json({ error: `Unable to restart ${stage} checkpoint.` });
}
