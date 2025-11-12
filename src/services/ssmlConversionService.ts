import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  OPENAI_SSML_MODEL,
  OUTPUT_DIR,
  TOKENS_PER_SSML_CHUNK,
  openaiClient,
  ssmlSystemPrompt,
} from "../config.ts";
import { ensureDirectory, createAudioFileName } from "../utils/fs.ts";
import { countTokens, splitTextIntoTokenChunks } from "../utils/text.ts";
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

export async function generateSsmlTextFileFromLlm(
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
  const ssmlOutputs: string[] = [];

  for (const [index, chunkText] of chunks.entries()) {
    console.log(`${jobLabel}Converting SSML chunk ${index + 1}/${chunks.length}.`);
    const ssml = await convertChunkToSsml(chunkText, index);
    ssmlOutputs.push(ssml.trim());
    console.log(
      `${jobLabel}Chunk ${index + 1}/${chunks.length} converted (${ssml.length} chars).`
    );
  }

  const annotatedSections = ssmlOutputs.map(
    (ssml, index) =>
      `<!-- Chunk ${index + 1} of ${ssmlOutputs.length} -->\n${ssml}`
  );
  const combinedFileContent = annotatedSections.join("\n\n").trim();

  await writeFile(filePath, combinedFileContent, { encoding: "utf8" });
  console.log(
    `${jobLabel}SSML chunks written to ${filePath} (${combinedFileContent.length} chars).`
  );

  const audioReadyChunks = createAudioChunksFromSsml(
    ssmlOutputs,
    TOKENS_PER_SSML_CHUNK
  );

  if (!audioReadyChunks.length) {
    throw new Error("Unable to prepare SSML chunks for audio synthesis.");
  }

  console.log(
    `${jobLabel}Re-chunked SSML to ${audioReadyChunks.length} chunk(s) for audio synthesis.`
  );

  return {
    fileName,
    filePath,
    chunkCount: audioReadyChunks.length,
    chunks: audioReadyChunks,
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

function stripOuterSpeakTags(ssml: string): string {
  const trimmed = ssml.trim();
  const speakOpenMatch = trimmed.match(/^<\s*speak\b[^>]*>/i);
  const speakCloseMatch = trimmed.match(/<\/\s*speak\s*>$/i);

  if (speakOpenMatch && speakCloseMatch) {
    return trimmed
      .slice(speakOpenMatch[0].length, trimmed.length - speakCloseMatch[0].length)
      .trim();
  }

  return trimmed;
}

function wrapWithSpeak(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const hasSpeakEnvelope =
    /^<\s*speak\b[^>]*>/i.test(trimmed) && /<\/\s*speak\s*>$/i.test(trimmed);

  if (hasSpeakEnvelope) {
    return trimmed;
  }

  return `<speak>\n${trimmed}\n</speak>`;
}

function createAudioChunksFromSsml(
  ssmlOutputs: string[],
  tokensPerChunk: number
): string[] {
  const normalizedBody = ssmlOutputs
    .map(stripOuterSpeakTags)
    .join("\n\n")
    .trim();

  if (!normalizedBody) {
    throw new Error("SSML conversion produced an empty SSML body.");
  }

  const nodes = splitTopLevelSsmlNodes(normalizedBody).filter(
    (node) => !node.startsWith("<!--")
  );

  if (!nodes.length) {
    return [];
  }

  const groupedNodes = groupSsmlNodesIntoChunks(nodes, tokensPerChunk);

  return groupedNodes
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => wrapWithSpeak(chunk));
}

function splitTopLevelSsmlNodes(ssml: string): string[] {
  const nodes: string[] = [];
  let index = 0;
  let depth = 0;
  let nodeStart = 0;
  const length = ssml.length;

  while (index < length) {
    if (ssml.startsWith("<!--", index)) {
      const end = ssml.indexOf("-->", index + 4);
      if (end === -1) {
        break;
      }

      if (depth === 0) {
        if (index > nodeStart) {
          const prefix = ssml.slice(nodeStart, index).trim();
          if (prefix) {
            nodes.push(prefix);
          }
        }
        nodes.push(ssml.slice(index, end + 3).trim());
        nodeStart = end + 3;
      }

      index = end + 3;
      continue;
    }

    const char = ssml[index];
    if (char === "<") {
      const tagEnd = ssml.indexOf(">", index + 1);
      if (tagEnd === -1) {
        break;
      }

      const tagContent = ssml.slice(index + 1, tagEnd).trim();
      const isClosing = tagContent.startsWith("/");
      const isSelfClosing = /\/\s*$/.test(tagContent);

      if (!isClosing && !isSelfClosing) {
        if (depth === 0 && index > nodeStart) {
          const prefix = ssml.slice(nodeStart, index).trim();
          if (prefix) {
            nodes.push(prefix);
          }
          nodeStart = index;
        }
        depth += 1;
      } else if (isSelfClosing) {
        if (depth === 0) {
          if (index > nodeStart) {
            const prefix = ssml.slice(nodeStart, index).trim();
            if (prefix) {
              nodes.push(prefix);
            }
          }
          nodes.push(ssml.slice(index, tagEnd + 1).trim());
          nodeStart = tagEnd + 1;
        }
      } else if (isClosing) {
        depth = Math.max(0, depth - 1);
        if (depth === 0) {
          const node = ssml.slice(nodeStart, tagEnd + 1).trim();
          if (node) {
            nodes.push(node);
          }
          nodeStart = tagEnd + 1;
        }
      }

      index = tagEnd + 1;
      continue;
    }

    index += 1;
  }

  if (nodeStart < length) {
    const tail = ssml.slice(nodeStart).trim();
    if (tail) {
      nodes.push(tail);
    }
  }

  return nodes;
}

function groupSsmlNodesIntoChunks(
  nodes: string[],
  tokensPerChunk: number
): string[] {
  const chunks: string[] = [];
  let currentNodes: string[] = [];
  let currentTokens = 0;
  const separator = "\n\n";
  const separatorTokens = countTokens(separator);

  for (const node of nodes) {
    const nodeTokens = countTokens(node);

    if (nodeTokens > tokensPerChunk) {
      if (currentNodes.length) {
        chunks.push(currentNodes.join("\n\n"));
        currentNodes = [];
        currentTokens = 0;
      }
      chunks.push(node);
      continue;
    }

    const joiningCost = currentNodes.length ? separatorTokens : 0;
    const projectedTokens = currentTokens + joiningCost + nodeTokens;

    if (currentNodes.length && projectedTokens > tokensPerChunk) {
      chunks.push(currentNodes.join("\n\n"));
      currentNodes = [];
      currentTokens = 0;
    }

    currentNodes.push(node);
    currentTokens += joiningCost + nodeTokens;
  }

  if (currentNodes.length) {
    chunks.push(currentNodes.join("\n\n"));
  }

  return chunks;
}
