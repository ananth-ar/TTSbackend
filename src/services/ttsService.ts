import mime from 'mime';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import {
  aiClient,
  DEFAULT_VOICE,
  MODEL_ID,
  OUTPUT_DIR,
  WORDS_PER_CHUNK,
} from '../config.ts';
import { createAudioFileName, ensureDirectory } from '../utils/fs.ts';
import type { AudioChunk } from '../utils/audio.ts';
import { combineAudioChunks, convertBase64ToWav } from '../utils/audio.ts';
import { splitTextIntoChunks } from '../utils/text.ts';

interface InlineDataPart {
  inlineData?: {
    data?: string;
    mimeType?: string;
  };
}

export interface PersistedAudio {
  fileName: string;
  filePath: string;
  mimeType: string;
}

export async function createAudioFile(
  text: string,
  customVoice?: string,
  requestedFileName?: string,
): Promise<PersistedAudio> {
  await ensureDirectory(OUTPUT_DIR);

  const voice = customVoice ?? DEFAULT_VOICE;
  const textChunks = splitTextIntoChunks(text, WORDS_PER_CHUNK);

  if (!textChunks.length) {
    throw new Error('Unable to split text into chunks.');
  }
  console.log('length of text chucks', textChunks.length)

  const audioChunks: AudioChunk[] = [];
  for (const chunk of textChunks) {
    const chunkAudio = await generateAudioFromText(chunk, voice);
    console.log('pushing', chunkAudio)
    audioChunks.push(chunkAudio);
  }

  const combinedAudio = combineAudioChunks(audioChunks);
  const extension = mime.getExtension(combinedAudio.mimeType) ?? 'wav';
  const fileName = createAudioFileName(extension, requestedFileName);
  const filePath = path.join(OUTPUT_DIR, fileName);

  await writeFile(filePath, combinedAudio.buffer);

  return { fileName, filePath, mimeType: combinedAudio.mimeType };
}

async function generateAudioFromText(text: string, voiceName: string): Promise<AudioChunk> {
  const contents = [
    {
      role: 'user' as const,
      parts: [{ text }],
    },
  ];

  const response = await aiClient.models.generateContentStream({
    model: MODEL_ID,
    config: {
      temperature: 0.7,
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName,
          },
        },
      },
    },
    contents,
  });

  const base64Chunks: string[] = [];
  let mimeType: string | undefined;

  for await (const chunk of response) {
    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    for (const part of parts) {
      const inlineData = (part as InlineDataPart).inlineData;
      if (!inlineData) {
        continue;
      }

      if (inlineData.data) {
        base64Chunks.push(inlineData.data);
      }

      if (inlineData.mimeType) {
        mimeType = inlineData.mimeType;
      }
    }
  }

  if (!base64Chunks.length) {
    throw new Error('Gemini did not return audio data.');
  }

  const combinedBase64 = base64Chunks.join('');
  if (!mimeType || !mime.getExtension(mimeType)) {
    return {
      buffer: convertBase64ToWav(combinedBase64, mimeType),
      mimeType: 'audio/wav',
    };
  }

  return {
    buffer: Buffer.from(combinedBase64, 'base64'),
    mimeType,
  };
}
