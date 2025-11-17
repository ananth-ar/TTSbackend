import { existsSync } from "node:fs";
import { readdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import { OUTPUT_DIR } from "../../config.ts";
import { createAudioFileName, ensureDirectory, sanitizeRequestedFileName } from "../../utils/fs.ts";
import { readJsonFile, writeJsonFile } from "../../utils/json.ts";
import type {
  AudioChunksManifest,
  AudioMetadataSnapshot,
  ChunkCheckpoint,
  ChunkProcessingState,
  RequestLayout,
  RequestMetadata,
  StatusSnapshot,
} from "./types.ts";

export const REQUEST_METADATA_FILE = "request.json";
export const AUDIO_CHUNKS_MANIFEST = "audio-chunks.json";
export const INPUT_TEXT_FILE = "input.txt";

export async function prepareRequestLayout(
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

export async function resolveExistingRequestLayout(
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

export async function writeInputTextSnapshot(
  requestDir: string,
  text: string
): Promise<void> {
  await ensureDirectory(requestDir);
  await writeFile(path.join(requestDir, INPUT_TEXT_FILE), `${text}\n`, {
    encoding: "utf8",
  });
}

export async function writeAudioChunksManifestSnapshot(
  requestDir: string,
  chunks: string[]
): Promise<void> {
  const manifest: AudioChunksManifest = {
    updatedAt: new Date().toISOString(),
    chunkCount: chunks.length,
    chunks,
  };

  await writeJsonFile(getManifestPath(requestDir), manifest);
}

export function getManifestPath(requestDir: string): string {
  return path.join(requestDir, AUDIO_CHUNKS_MANIFEST);
}

export async function readAudioChunksManifestSnapshot(
  requestDir: string
): Promise<AudioChunksManifest | undefined> {
  return readJsonFile<AudioChunksManifest>(getManifestPath(requestDir));
}

export async function readRequestMetadata(
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

export async function updateRequestMetadata(
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

export async function persistSsmlChunks(
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

export async function loadChunkProcessingStates(
  requestDir: string
): Promise<ChunkProcessingState[]> {
  const entries = await readdir(requestDir, { withFileTypes: true });
  const checkpoints = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => createChunkCheckpoint(requestDir, Number(entry.name)))
    .sort((a, b) => a.chunkIndex - b.chunkIndex);

  const states: ChunkProcessingState[] = [];
  for (const checkpoint of checkpoints) {
    const audioStatus =
      (await readJsonFile<StatusSnapshot>(checkpoint.audioStatusFilePath)) ??
      (await repairCheckpointStatusFile(checkpoint, "audio"));
    const accuracyStatus =
      (await readJsonFile<StatusSnapshot>(checkpoint.accuracyStatusFilePath)) ??
      (await repairCheckpointStatusFile(checkpoint, "accuracy"));
    const audioMetadata =
      await readJsonFile<AudioMetadataSnapshot>(
        checkpoint.audioMetadataFilePath
      );

    const audioFilePath =
      audioMetadata && audioMetadata.fileName
        ? path.join(checkpoint.chunkDir, audioMetadata.fileName)
        : undefined;
    const hasAudioFile =
      Boolean(audioFilePath) && audioFilePath
        ? existsSync(audioFilePath)
        : false;

    states.push({
      checkpoint,
      audioAttempts: audioStatus.attempt ?? 0,
      verificationAttempts: accuracyStatus.attempt ?? 0,
      accuracyStatus: accuracyStatus.status,
      audioReady: hasAudioFile,
      verified: accuracyStatus.status === "success",
      audioFilePath: hasAudioFile ? audioFilePath : undefined,
      mimeType: audioMetadata?.mimeType,
    });
  }

  return states;
}

export function validateChunkIndices(
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

export function createChunkCheckpoint(
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

function getRequestMetadataPath(requestDir: string): string {
  return path.join(requestDir, REQUEST_METADATA_FILE);
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

function normalizeTargetName(targetName: string): string {
  const trimmed = targetName.trim();
  const sanitized = sanitizeRequestedFileName(trimmed);
  if (sanitized) {
    return sanitized;
  }
  const lastSegment = trimmed.replace(/\\/g, "/").split("/").pop() ?? trimmed;
  return lastSegment;
}

async function repairCheckpointStatusFile(
  checkpoint: ChunkCheckpoint,
  type: "audio" | "accuracy"
): Promise<StatusSnapshot> {
  await ensureSsmlChunkSnapshot(checkpoint);
  const snapshot: StatusSnapshot = {
    status: "pending",
    attempt: 0,
    updatedAt: new Date().toISOString(),
    message: "Reinitialized after corrupted data.",
  };
  const targetPath =
    type === "audio"
      ? checkpoint.audioStatusFilePath
      : checkpoint.accuracyStatusFilePath;
  await writeJsonFile(targetPath, snapshot);
  console.warn(
    `Recreated ${type} status file for chunk ${checkpoint.chunkIndex} at ${targetPath}.`
  );
  return snapshot;
}

async function ensureSsmlChunkSnapshot(
  checkpoint: ChunkCheckpoint
): Promise<void> {
  try {
    const payload = await readFile(checkpoint.ssmlFilePath, {
      encoding: "utf8",
    });
    if (!payload.trim()) {
      throw new Error(
        `Chunk ${checkpoint.chunkIndex} is missing SSML content at ${checkpoint.ssmlFilePath}. Regenerate SSML before continuing.`
      );
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(
        `Chunk ${checkpoint.chunkIndex} is missing ${path.basename(
          checkpoint.ssmlFilePath
        )}. Run the SSML checkpoint before retrying.`
      );
    }
    throw error;
  }
}
