import { readFile, writeFile } from "node:fs/promises";

export async function writeJsonFile<T>(
  filePath: string,
  data: T
): Promise<void> {
  const payload = JSON.stringify(data, null, 2);
  await writeFile(filePath, payload, { encoding: "utf8" });
}

export async function readJsonFile<T>(
  filePath: string
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, { encoding: "utf8" });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.warn(
        `Failed to parse JSON file at ${filePath}: ${error.message}. Treating as undefined.`
      );
      return undefined;
    }
    throw error;
  }
}
