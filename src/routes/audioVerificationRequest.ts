import type { Request } from "express";
import path from "node:path";
import {
  parseMultipartFormData,
  type ParsedMultipartFormData,
} from "../utils/multipart.ts";

const AUDIO_UPLOAD_LIMIT_MB = Number.parseInt(
  process.env.AUDIO_UPLOAD_LIMIT_MB ?? "25",
  10
);

export const MAX_AUDIO_UPLOAD_BYTES =
  Number.isFinite(AUDIO_UPLOAD_LIMIT_MB) && AUDIO_UPLOAD_LIMIT_MB > 0
    ? AUDIO_UPLOAD_LIMIT_MB * 1024 * 1024
    : 25 * 1024 * 1024;
export const AUDIO_UPLOAD_LIMIT_MB_DISPLAY = Math.round(
  MAX_AUDIO_UPLOAD_BYTES / (1024 * 1024)
);
const MULTIPART_PAYLOAD_LIMIT = Math.ceil(MAX_AUDIO_UPLOAD_BYTES * 1.2);

const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  ".wav",
  ".wax",
  ".flac",
  ".mp3",
  ".m4a",
  ".ogg",
  ".webm",
]);

export interface AudioVerificationPayload {
  text: string;
  audioBuffer: Buffer;
  fileName?: string;
  mimeType?: string;
}

export class RequestValidationError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "RequestValidationError";
    this.statusCode = statusCode;
  }
}

export async function extractAudioVerificationPayload(
  req: Request
): Promise<AudioVerificationPayload> {
  if (req.is("multipart/form-data")) {
    const formData = await parseMultipartSafely(req);
    const textField =
      formData.fields.text ??
      formData.fields.expectedText ??
      formData.fields.prompt;
    if (typeof textField !== "string" || !textField.trim()) {
      throw new RequestValidationError(
        "The `text` field is required in the multipart payload."
      );
    }

    const audioFile =
      formData.files.audio ??
      formData.files.file ??
      formData.files.upload ??
      Object.values(formData.files)[0];

    if (!audioFile) {
      throw new RequestValidationError(
        "Attach the audio file under the `audio` field."
      );
    }

    if (!audioFile.data?.length) {
      throw new RequestValidationError("Uploaded audio file is empty.");
    }

    ensureSupportedAudioType(audioFile.fileName, audioFile.contentType);
    return {
      text: textField.trim(),
      audioBuffer: audioFile.data,
      fileName: audioFile.fileName,
      mimeType: audioFile.contentType,
    };
  }

  if (!req.body || typeof req.body !== "object") {
    throw new RequestValidationError(
      "Provide JSON with `text` plus `audioBase64`, or submit multipart form data."
    );
  }

  const body = req.body as Record<string, unknown>;
  const rawText =
    (typeof body.text === "string" && body.text) ||
    (typeof body.expectedText === "string" && body.expectedText);
  if (!rawText || !rawText.trim()) {
    throw new RequestValidationError("The `text` field is required.");
  }

  const audioString =
    (typeof body.audioBase64 === "string" && body.audioBase64) ||
    (typeof body.audio === "string" && body.audio);

  if (!audioString) {
    throw new RequestValidationError(
      "Include the audio data using the `audioBase64` (or `audio`) field."
    );
  }

  const { base64, mimeTypeFromData } = extractBase64Payload(audioString);
  let audioBuffer: Buffer;
  try {
    audioBuffer = Buffer.from(base64, "base64");
  } catch {
    throw new RequestValidationError("Invalid base64 audio payload.");
  }

  if (!audioBuffer.length) {
    throw new RequestValidationError("Audio payload decoded to empty data.");
  }

  const fileName =
    typeof body.fileName === "string" && body.fileName.trim()
      ? body.fileName.trim()
      : undefined;

  ensureSupportedAudioType(fileName, mimeTypeFromData);

  return {
    text: rawText.trim(),
    audioBuffer,
    fileName,
    mimeType: mimeTypeFromData,
  };
}

async function parseMultipartSafely(
  req: Request
): Promise<ParsedMultipartFormData> {
  try {
    return await parseMultipartFormData(req, {
      maxSizeBytes: MULTIPART_PAYLOAD_LIMIT,
    });
  } catch (error) {
    if (error instanceof Error && /size limit/i.test(error.message ?? "")) {
      throw new RequestValidationError(
        `Multipart payload exceeds the ${AUDIO_UPLOAD_LIMIT_MB_DISPLAY}MB limit.`,
        413
      );
    }
    throw error;
  }
}

function extractBase64Payload(value: string): {
  base64: string;
  mimeTypeFromData?: string;
} {
  const trimmed = value.trim();
  const dataUrlMatch = trimmed.match(/^data:(.*?);base64,(.+)$/i);
  if (dataUrlMatch) {
    return {
      base64: dataUrlMatch[2] ?? "",
      mimeTypeFromData: dataUrlMatch[1]?.toLowerCase(),
    };
  }

  return { base64: trimmed };
}

function ensureSupportedAudioType(
  fileName?: string,
  mimeType?: string
): void {
  if (fileName) {
    const extension = path.extname(fileName).toLowerCase();
    if (extension && !SUPPORTED_AUDIO_EXTENSIONS.has(extension)) {
      throw new RequestValidationError(
        `Unsupported audio file extension "${extension}". Accepted extensions: ${[
          ...SUPPORTED_AUDIO_EXTENSIONS,
        ].join(", ")}.`
      );
    }
  }

  if (
    mimeType &&
    !mimeType.startsWith("audio/") &&
    mimeType !== "application/octet-stream"
  ) {
    throw new RequestValidationError(
      `Unsupported audio mime type "${mimeType}".`
    );
  }
}
