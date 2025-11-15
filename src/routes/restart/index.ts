import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";

import {
  restartAccuracyCheckpoint,
  restartAudioCheckpoint,
  restartChunkCheckpoint,
  restartMergeCheckpoint,
  restartSsmlCheckpoint,
} from "../../services/processTexttoSpeechService.ts";

const router = Router();

// Payload: { targetName: string, text?: string, voiceName?: string }
router.post("/tts/restart/ssml", async (req: Request, res: Response) => {
  const jobId = randomUUID();
  try {
    const targetName = requireTargetName(req.body);
    const text = parseOptionalString(req.body?.text, "`text`");
    const voiceName = parseOptionalString(req.body?.voiceName, "`voiceName`");

    const result = await restartSsmlCheckpoint({
      targetName,
      text,
      voiceName,
      jobId,
    });

    res.json({
      jobId,
      requestDirectory: result.requestDirectory,
      ssmlFileName: result.ssmlFileName,
      chunkCount: result.chunkCount,
      manifestPath: result.manifestPath,
    });
  } catch (error) {
    handleRestartError(res, "ssml", jobId, error);
  }
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

// Payload: { targetName: string, chunkIndices?: number[], voiceName?: string, regenerateAll?: boolean }
router.post("/tts/restart/audio", async (req: Request, res: Response) => {
  const jobId = randomUUID();
  try {
    const targetName = requireTargetName(req.body);
    const chunkIndices = parseChunkIndices(req.body?.chunkIndices);
    const voiceName = parseOptionalString(req.body?.voiceName, "`voiceName`");
    const regenerateAll = parseOptionalBoolean(
      req.body?.regenerateAll,
      "`regenerateAll`"
    );

    const result = await restartAudioCheckpoint({
      targetName,
      chunkIndices,
      regenerateAll: regenerateAll ?? false,
      voiceName,
      jobId,
    });

    res.json({
      jobId,
      totalRequested: result.totalRequested,
      successes: result.successes,
      failures: result.failures,
    });
  } catch (error) {
    handleRestartError(res, "audio", jobId, error);
  }
});

// Payload: { targetName: string, chunkIndices?: number[] }
router.post("/tts/restart/accuracy", async (req: Request, res: Response) => {
  const jobId = randomUUID();
  try {
    const targetName = requireTargetName(req.body);
    const chunkIndices = parseChunkIndices(req.body?.chunkIndices);

    const result = await restartAccuracyCheckpoint({
      targetName,
      chunkIndices,
      jobId,
    });

    res.json({
      jobId,
      totalRequested: result.totalRequested,
      successes: result.successes,
      failures: result.failures,
    });
  } catch (error) {
    handleRestartError(res, "accuracy", jobId, error);
  }
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
