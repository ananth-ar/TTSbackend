import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { finished } from "node:stream/promises";
import path from "node:path";

import {
  OPENAI_SSML_MODEL,
  OUTPUT_DIR,
  TOKENS_PER_SSML_CHUNK,
  openaiClient,
  ssmlSystemPrompt,
} from "../config.ts";
import { ensureDirectory, createAudioFileName } from "../utils/fs.ts";
import { splitTextIntoTokenChunks } from "../utils/text.ts";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessage,
} from "openai/resources/chat/completions";

export interface SsmlFileResult {
  fileName: string;
  filePath: string;
  chunkCount: number;
  chunks: string[];
}

export interface SsmlConversionOptions {
  jobId?: string;
}

export async function generateSsmlFileFromLlmText(
  text: string,
  requestedFileName?: string,
  options?: SsmlConversionOptions
): Promise<SsmlFileResult> {
  await ensureDirectory(OUTPUT_DIR);
  const jobLabel = createJobLabel(options?.jobId, "SSML");

  console.log(
    `${jobLabel}Starting SSML conversion (chunk size: ${TOKENS_PER_SSML_CHUNK} tokens).`
  );

  const chunks = splitTextIntoTokenChunks(text, TOKENS_PER_SSML_CHUNK);
  if (!chunks.length) {
    throw new Error("Unable to split text into token chunks.");
  }

  console.log(`${jobLabel}Split text into ${chunks.length} chunk(s).`);

  const fileName = createAudioFileName("txt", requestedFileName);
  const filePath = path.join(OUTPUT_DIR, fileName);
  const writeStream = createWriteStream(filePath, { encoding: "utf8" });
  const ssmlOutputs: string[] = [];

  try {
    for (const [index, chunkText] of chunks.entries()) {
      console.log(
        `${jobLabel}Converting SSML chunk ${index + 1}/${chunks.length}.`
      );
      const ssml = await convertChunkToSsml(chunkText, index);
      ssmlOutputs.push(ssml);
      console.log(
        `${jobLabel}Chunk ${index + 1}/${chunks.length} converted (${
          ssml.length
        } chars).`
      );

      writeStream.write(
        `<!-- Chunk ${index + 1} of ${chunks.length} -->\n${ssml.trim()}\n\n`
      );
    }
  } catch (error) {
    console.error(`${jobLabel}SSML conversion failed. Cleaning up.`, error);
    writeStream.destroy();
    await rm(filePath, { force: true }).catch(() => {});
    throw error;
  } finally {
    writeStream.end();
  }

  await finished(writeStream);
  console.log(`${jobLabel}SSML chunks written to ${filePath}`);

  return {
    fileName,
    filePath,
    chunkCount: ssmlOutputs.length,
    chunks: ssmlOutputs,
  };
}

async function convertChunkToSsml(
  chunkText: string,
  chunkIndex: number
): Promise<string> {
  const response = await openaiClient.chat.completions.create({
    model: OPENAI_SSML_MODEL,
    temperature: 1,
    messages: [
      { role: "system", content: ssmlSystemPrompt },
      {
        role: "user",
        content: chunkText,
      },
    ],
  });

  const choice = response.choices?.[0];
  const message = choice?.message as ChatCompletionMessage | undefined;
  const rawContent = message?.content;
  const textContent = normalizeCompletionContent(rawContent);

  if (!textContent?.trim()) {
    throw new Error(`Received empty SSML for chunk ${chunkIndex + 1}.`);
  }

  return textContent.trim();
}

function normalizeCompletionContent(
  content: string | ChatCompletionContentPart[] | null | undefined
): string | undefined {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? part.text ?? "" : ""))
      .join("");
  }

  return undefined;
}

function createJobLabel(jobId: string | undefined, fallback: string): string {
  if (jobId) {
    return `[Job ${jobId}][${fallback}] `;
  }

  return `[${fallback}] `;
}
