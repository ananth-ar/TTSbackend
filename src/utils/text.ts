export function countWords(text: string): number {
  if (!text) {
    return 0;
  }

  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function splitTextIntoChunks(text: string, chunkSize: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [];
  }

  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += chunkSize) {
    const chunkWords = words.slice(index, index + chunkSize);
    chunks.push(chunkWords.join(' '));
  }

  return chunks;
}
