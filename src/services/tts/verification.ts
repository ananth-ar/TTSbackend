import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { transcribeAndCompareAudio } from "../audioVerificationService.ts";
import { writeJsonFile } from "../../utils/json.ts";
import { ssmlToPlainText } from "../../utils/ssml.ts";
import type {
  ChunkCheckpoint,
  ChunkVerificationJob,
  ChunkVerificationOutcome,
} from "./types.ts";

export async function verifyChunkAudioFiles(
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
