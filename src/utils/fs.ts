import { mkdir } from 'node:fs/promises';

export async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
}

export function createAudioFileName(extension: string): string {
  const safeExtension = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'wav';
  const uniqueId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return `tts-${uniqueId}.${safeExtension}`;
}
