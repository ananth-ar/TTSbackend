import { generateSsmlFileFromLlmText } from "./ssmlConversionService.ts";
import {
  synthesizeAudioFromSsmlChunks,
  type PersistedAudio,
} from "./ttsService.ts";

export interface LlmTextProcessingParams {
  text: string;
  voiceName?: string;
  requestedFileName?: string;
  jobId: string;
}

export interface LlmTextProcessingResult {
  ssmlFileName: string;
  audio?: PersistedAudio;
  chunkCount: number;
}

export async function processLlmTextProcessingJob(
  params: LlmTextProcessingParams
): Promise<LlmTextProcessingResult> {
  const { text, voiceName, requestedFileName, jobId } = params;

  console.log(`[Job ${jobId}] Starting llmtextprocessing pipeline.`);

  const ssmlResult = await generateSsmlFileFromLlmText(
    text,
    requestedFileName ? `${requestedFileName}-ssml` : undefined,
    { jobId }
  );

  console.log(
    `[Job ${jobId}] SSML conversion complete: ${ssmlResult.chunkCount} chunk(s), file ${ssmlResult.filePath}.`
  );

  let audio: PersistedAudio | undefined;
  try {
    audio = await synthesizeAudioFromSsmlChunks(
      ssmlResult.chunks,
      voiceName,
      requestedFileName,
      { jobId }
    );
    console.log(
      `[Job ${jobId}] Audio synthesis complete. Saved to ${audio.filePath}.`
    );
  } catch (error) {
    console.error(
      `[Job ${jobId}] Audio synthesis encountered an error after generating available chunks.`,
      error
    );
  }

  return {
    ssmlFileName: ssmlResult.fileName,
    chunkCount: ssmlResult.chunkCount,
    audio,
  };
}
