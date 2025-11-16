export interface ProcessTexttoSpeechParams {
  text: string;
  voiceName?: string;
  requestedFileName?: string;
  jobId: string;
}

export interface ProcessTexttoSpeechResult {
  ssmlFileName: string;
  audio?: PersistedAudio;
  chunkCount: number;
  requestDirectory: string;
}

export type GeminiTtsGenerationMode = "stream" | "batch" | "parallel";

export interface SynthesizeAudioOptions {
  jobId?: string;
  totalChunkCount?: number;
  modeOverride?: GeminiTtsGenerationMode;
  parallelism?: number;
}

export interface RequestLayout {
  baseName: string;
  requestDir: string;
  finalAudioFileName: string;
  finalAudioFilePath: string;
}

export interface RequestMetadata {
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

export interface AudioChunksManifest {
  updatedAt: string;
  chunkCount: number;
  chunks: string[];
}

export interface StatusSnapshot {
  status?: string;
  attempt?: number;
  updatedAt?: string;
  message?: string;
}

export interface AudioMetadataSnapshot {
  chunkIndex: number;
  attempt: number;
  mimeType: string;
  fileName: string;
  updatedAt: string;
}

export interface ChunkCheckpoint {
  chunkIndex: number;
  chunkDir: string;
  chunkLabel: string;
  ssmlFilePath: string;
  textFilePath: string;
  audioStatusFilePath: string;
  audioMetadataFilePath: string;
  accuracyStatusFilePath: string;
}

export interface ChunkProcessingState {
  checkpoint: ChunkCheckpoint;
  audioAttempts: number;
  verificationAttempts: number;
  audioReady: boolean;
  verified: boolean;
  audioFilePath?: string;
  mimeType?: string;
}

export interface SsmlChunkTask extends ChunkCheckpoint {
  attempt: number;
}

export interface ChunkAudioJobResult {
  chunkIndex: number;
  attempt: number;
  success: boolean;
  audioFilePath?: string;
  mimeType?: string;
  error?: string;
}

export interface PersistedAudio {
  fileName: string;
  filePath: string;
  mimeType: string;
}

export interface ChunkVerificationJob {
  checkpoint: ChunkCheckpoint;
  audioFilePath: string;
  mimeType: string;
  attempt: number;
}

export interface ChunkVerificationOutcome {
  chunkIndex: number;
  attempt: number;
  success: boolean;
  error?: string;
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
  regenerateOnlyMissing?: boolean;
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
