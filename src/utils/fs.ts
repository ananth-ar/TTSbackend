import { mkdir } from "node:fs/promises";

export async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
}

export function createAudioFileName(
  extension: string,
  requestedName?: string
): string {
  const safeExtension = sanitizeExtension(extension);
  const userDefinedName = sanitizeRequestedFileName(requestedName);

  if (userDefinedName) {
    return `${userDefinedName}.${safeExtension}`;
  }

  const uniqueId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return `tts-${uniqueId}.${safeExtension}`;
}

function sanitizeExtension(extension: string): string {
  return extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "wav";
}

function sanitizeRequestedFileName(rawName?: string): string | undefined {
  if (!rawName || typeof rawName !== "string") {
    return undefined;
  }

  const trimmed = rawName.trim();
  if (!trimmed) {
    return undefined;
  }

  const withoutPath = trimmed.replace(/\\/g, "/").split("/").pop() ?? "";
  const withoutExtension = withoutPath.replace(/\.[^.]+$/, "");

  const normalized = withoutExtension
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  const asciiOnly = normalized.replace(/[^\w\s-]/g, "");
  const dashed = asciiOnly.replace(/\s+/g, "-");
  const collapsed = dashed.replace(/-+/g, "-").replace(/^-|-$/g, "");

  if (!collapsed) {
    return undefined;
  }

  return collapsed.slice(0, 100).toLowerCase();
}
