export { processTexttoSpeechJob } from "./tts/pipeline.ts";
export {
  restartSsmlCheckpoint,
  restartChunkCheckpoint,
  restartAudioCheckpoint,
  restartAccuracyCheckpoint,
  restartMergeCheckpoint,
} from "./tts/restarts.ts";

export type {
  ProcessTexttoSpeechParams as processTexttoSpeechParams,
  ProcessTexttoSpeechResult as processTexttoSpeechResult,
  RestartSsmlParams,
  RestartSsmlResult,
  RestartChunksParams,
  RestartChunksResult,
  RestartAudioParams,
  RestartAudioResult,
  RestartAccuracyParams,
  RestartAccuracyResult,
  RestartMergeParams,
} from "./tts/types.ts";
