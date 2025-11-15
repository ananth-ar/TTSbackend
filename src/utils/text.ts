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

export function normalizeTextForComparison(text: string): string {
  if (!text) {
    return "";
  }

  const simplified = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return simplified;
}

export function tokenizeForComparison(text: string): string[] {
  const normalized = normalizeTextForComparison(text);
  if (!normalized) {
    return [];
  }

  return normalized.split(" ").filter(Boolean);
}

export interface WordDiffEntry {
  word: string;
  expectedCount: number;
  actualCount: number;
}

export interface WordOverlapStats {
  overlappingWordCount: number;
  missingWords: WordDiffEntry[];
  extraWords: WordDiffEntry[];
}

export function analyzeWordOverlap(
  expectedWords: string[],
  actualWords: string[]
): WordOverlapStats {
  const expectedCounts = createFrequencyMap(expectedWords);
  const actualCounts = createFrequencyMap(actualWords);
  let overlappingWordCount = 0;
  const missingWords: WordDiffEntry[] = [];
  const extraWords: WordDiffEntry[] = [];

  for (const [word, expectedCount] of expectedCounts) {
    const actualCount = actualCounts.get(word) ?? 0;
    overlappingWordCount += Math.min(expectedCount, actualCount);
    if (expectedCount > actualCount) {
      missingWords.push({ word, expectedCount, actualCount });
    }
  }

  for (const [word, actualCount] of actualCounts) {
    const expectedCount = expectedCounts.get(word) ?? 0;
    if (actualCount > expectedCount) {
      extraWords.push({ word, expectedCount, actualCount });
    }
  }

  return {
    overlappingWordCount,
    missingWords,
    extraWords,
  };
}

function createFrequencyMap(words: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of words) {
    if (!word) {
      continue;
    }
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

export function levenshteinDistance(a: string[], b: string[]): number {
  if (a.length === 0) {
    return b.length;
  }

  if (b.length === 0) {
    return a.length;
  }

  if (a.length < b.length) {
    [a, b] = [b, a];
  }

  let previousRow = new Array<number>(b.length + 1);
  let currentRow = new Array<number>(b.length + 1);

  for (let col = 0; col <= b.length; col += 1) {
    previousRow[col] = col;
  }

  for (let row = 1; row <= a.length; row += 1) {
    currentRow[0] = row;
    for (let col = 1; col <= b.length; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      currentRow[col] = Math.min(
        currentRow[col - 1]! + 1,
        previousRow[col]! + 1,
        previousRow[col - 1]! + cost
      );
    }

    const temp = previousRow;
    previousRow = currentRow;
    currentRow = temp;
  }

  return previousRow[b.length]!;
}

export function calculateWordMatchPercentage(
  expectedWords: string[],
  actualWords: string[]
): number {
  const MAX_DISTANCE_WORDS = 5000;
  const truncatedExpected = expectedWords.slice(0, MAX_DISTANCE_WORDS);
  const truncatedActual = actualWords.slice(0, MAX_DISTANCE_WORDS);

  const maxLength = Math.max(
    truncatedExpected.length,
    truncatedActual.length
  );
  if (maxLength === 0) {
    return 100;
  }

  const distance = levenshteinDistance(truncatedExpected, truncatedActual);
  const score = Math.max(0, 1 - distance / maxLength);
  return Number((score * 100).toFixed(2));
}
