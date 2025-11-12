import { decode, encode } from "gpt-tokenizer";

export function countWords(text: string): number {
  if (!text) {
    return 0;
  }

  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function countTokens(text: string): number {
  if (!text) {
    return 0;
  }

  return encode(text).length;
}

export function splitTextIntoChunks(text: string, chunkSize: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [];
  }

  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += chunkSize) {
    const chunkWords = words.slice(index, index + chunkSize);
    chunks.push(chunkWords.join(" "));
  }

  return chunks;
}

export function splitTextIntoTokenChunks(
  text: string,
  tokensPerChunk: number
): string[] {
  if (!Number.isFinite(tokensPerChunk) || tokensPerChunk <= 0) {
    throw new Error("tokensPerChunk must be a positive integer.");
  }

  const tokenIds = encode(text);
  if (!tokenIds.length) {
    return [];
  }

  const chunks: string[] = [];
  for (let index = 0; index < tokenIds.length; index += tokensPerChunk) {
    const chunkTokens = tokenIds.slice(index, index + tokensPerChunk);
    chunks.push(decode(chunkTokens));
  }

  return chunks;
}
