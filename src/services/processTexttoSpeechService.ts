import { generateSsmlTextFileFromLlm } from "./ssmlConversionService.ts";
import {
  // synthesizeAudioFromSsmlChunks,
  type PersistedAudio,
} from "./ttsService.ts";
import { synthesizeAudioFromSsmlChunksBatch } from "./ttsBatchService.ts";

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
}

export async function processTexttoSpeechJob(
  params: processTexttoSpeechParams
): Promise<processTexttoSpeechResult> {
  const { text, voiceName, requestedFileName, jobId } = params;

  console.log(`[Job ${jobId}] Starting processTexttoSpeech pipeline.`);

  const ssmlResult = await generateSsmlTextFileFromLlm(
    text,
    requestedFileName ? `${requestedFileName}-ssml` : undefined,
    { jobId }
  );

  console.log(
    `[Job ${jobId}] SSML conversion complete: ${ssmlResult.chunkCount} chunk(s), file ${ssmlResult.filePath}.`
  );

  let audio: PersistedAudio | undefined;
  try {
    // audio = await synthesizeAudioFromSsmlChunks(
    //   ssmlResult.chunks,
    //   voiceName,
    //   requestedFileName,
    //   { jobId }
    // );
    audio = await synthesizeAudioFromSsmlChunksBatch(
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
