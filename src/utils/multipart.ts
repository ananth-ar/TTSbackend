import type { Request } from "express";

export interface ParsedMultipartFile {
  fileName: string;
  contentType?: string;
  data: Buffer;
}

export interface ParsedMultipartFormData {
  fields: Record<string, string>;
  files: Record<string, ParsedMultipartFile>;
}

export interface ParseMultipartOptions {
  maxSizeBytes?: number;
}

const CRLF = Buffer.from("\r\n");
const HEADER_DELIMITER = Buffer.from("\r\n\r\n");

export async function parseMultipartFormData(
  req: Request,
  options?: ParseMultipartOptions
): Promise<ParsedMultipartFormData> {
  const contentType = req.headers["content-type"];
  if (!contentType || !contentType.includes("multipart/form-data")) {
    throw new Error("Request does not contain multipart form data.");
  }

  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    throw new Error("Multipart boundary is missing from the request.");
  }

  const boundaryToken = boundaryMatch[1] ?? boundaryMatch[2];
  const boundaryBuffer = Buffer.from(`--${boundaryToken}`);
  const maxSizeBytes = options?.maxSizeBytes ?? 25 * 1024 * 1024;

  const bodyBuffer = await readRequestBody(req, maxSizeBytes);
  const fields: Record<string, string> = {};
  const files: Record<string, ParsedMultipartFile> = {};

  let offset = bodyBuffer.indexOf(boundaryBuffer);
  if (offset === -1) {
    return { fields, files };
  }

  offset += boundaryBuffer.length;

  while (offset < bodyBuffer.length) {
    if (isDoubleDash(bodyBuffer, offset)) {
      break;
    }

    offset = skipCrlf(bodyBuffer, offset);
    if (offset >= bodyBuffer.length) {
      break;
    }

    const nextBoundaryIndex = bodyBuffer.indexOf(boundaryBuffer, offset);
    if (nextBoundaryIndex === -1) {
      break;
    }

    let partBuffer = bodyBuffer.slice(offset, nextBoundaryIndex);
    partBuffer = trimCrlf(partBuffer);
    if (!partBuffer.length) {
      offset = nextBoundaryIndex + boundaryBuffer.length;
      continue;
    }

    const headerEndIndex = partBuffer.indexOf(HEADER_DELIMITER);
    if (headerEndIndex === -1) {
      offset = nextBoundaryIndex + boundaryBuffer.length;
      continue;
    }

    const headerSection = partBuffer
      .slice(0, headerEndIndex)
      .toString("utf8")
      .trim();
    const content = partBuffer.slice(headerEndIndex + HEADER_DELIMITER.length);
    const headers = parseHeaderSection(headerSection);
    const disposition = headers["content-disposition"];
    if (!disposition) {
      offset = nextBoundaryIndex + boundaryBuffer.length;
      continue;
    }

    const nameMatch = disposition.match(/name="([^"]+)"/i);
    const fieldName = nameMatch?.[1];
    if (!fieldName) {
      offset = nextBoundaryIndex + boundaryBuffer.length;
      continue;
    }

    const fileNameMatch = disposition.match(/filename="([^"]*)"/i);
    const fileName = fileNameMatch?.[1]?.trim();

    if (fileName) {
      files[fieldName] = {
        fileName,
        contentType: headers["content-type"],
        data: content,
      };
    } else {
      fields[fieldName] = content.toString("utf8");
    }

    offset = nextBoundaryIndex + boundaryBuffer.length;
  }

  return { fields, files };
}

async function readRequestBody(
  req: Request,
  maxSizeBytes: number
): Promise<Buffer> {
  if (req.readableEnded) {
    throw new Error("Request body was already consumed.");
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    function cleanup(): void {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    }

    function onData(chunk: Buffer | string): void {
      const bufferChunk = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, "utf8");
      totalBytes += bufferChunk.length;
      if (totalBytes > maxSizeBytes) {
        cleanup();
        reject(new Error("Multipart payload exceeds size limit."));
        return;
      }
      chunks.push(bufferChunk);
    }

    function onEnd(): void {
      cleanup();
      resolve(Buffer.concat(chunks));
    }

    function onError(error: Error): void {
      cleanup();
      reject(error);
    }

    function onAborted(): void {
      cleanup();
      reject(new Error("Request aborted while reading multipart payload."));
    }

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

function parseHeaderSection(rawHeaders: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!rawHeaders) {
    return headers;
  }

  const lines = rawHeaders.split(/\r?\n/);
  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) {
      headers[key] = value;
    }
  }

  return headers;
}

function trimCrlf<T extends ArrayBufferLike>(buffer: Buffer<T>): Buffer<T> {
  let result = buffer;

  if (
    result.length >= 2 &&
    result[0] === CRLF[0] &&
    result[1] === CRLF[1]
  ) {
    result = result.slice(2) as Buffer<T>;
  }

  if (
    result.length >= 2 &&
    result[result.length - 2] === CRLF[0] &&
    result[result.length - 1] === CRLF[1]
  ) {
    result = result.slice(0, -2) as Buffer<T>;
  }

  return result;
}

function skipCrlf<T extends ArrayBufferLike>(
  buffer: Buffer<T>,
  startIndex: number
): number {
  let index = startIndex;
  while (
    index + 1 < buffer.length &&
    buffer[index] === CRLF[0] &&
    buffer[index + 1] === CRLF[1]
  ) {
    index += 2;
  }
  return index;
}

function isDoubleDash<T extends ArrayBufferLike>(
  buffer: Buffer<T>,
  index: number
): boolean {
  if (index + 1 >= buffer.length) {
    return false;
  }

  return buffer[index] === 45 && buffer[index + 1] === 45;
}
