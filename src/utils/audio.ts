export interface WavConversionOptions {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}

export interface AudioChunk {
  buffer: Buffer;
  mimeType: string;
}

export function convertBase64ToWav(
  rawBase64: string,
  mimeType?: string
): Buffer {
  const options = parseMimeType(mimeType);
  const rawBuffer = Buffer.from(rawBase64, "base64");
  const wavHeader = createWavHeader(rawBuffer.length, options);

  return Buffer.concat([wavHeader, rawBuffer]);
}

export function combineAudioChunks(chunks: AudioChunk[]): AudioChunk {
  if (!chunks.length) {
    throw new Error("No audio chunks available to merge.");
  }

  const [firstChunk, ...restChunks] = chunks;
  if (!firstChunk) {
    throw new Error("Missing primary audio chunk.");
  }

  const allWav = chunks.every((chunk) => chunk.mimeType === "audio/wav");
  if (allWav) {
    const wavBuffers = [
      firstChunk.buffer,
      ...restChunks.map((chunk) => chunk.buffer),
    ];
    return {
      buffer: mergeWavBuffers(wavBuffers),
      mimeType: "audio/wav",
    };
  }

  const firstMimeType = firstChunk.mimeType;
  const consistent = restChunks.every(
    (chunk) => chunk.mimeType === firstMimeType
  );
  if (!consistent) {
    throw new Error(
      "Gemini returned inconsistent audio formats across chunks."
    );
  }

  return {
    buffer: Buffer.concat([
      firstChunk.buffer,
      ...restChunks.map((chunk) => chunk.buffer),
    ]),
    mimeType: firstMimeType,
  };
}

export function parseMimeType(mimeType?: string): WavConversionOptions {
  const defaults: WavConversionOptions = {
    numChannels: 1,
    sampleRate: 24000,
    bitsPerSample: 16,
  };

  if (!mimeType) {
    return defaults;
  }

  const [type, ...params] = mimeType.split(";").map((value) => value.trim());
  const overrides: Partial<WavConversionOptions> = {};

  if (type) {
    const [, format] = type.split("/");
    if (format?.toUpperCase().startsWith("L")) {
      const bits = Number.parseInt(format.slice(1), 10);
      if (!Number.isNaN(bits)) {
        overrides.bitsPerSample = bits;
      }
    }
  }

  for (const param of params) {
    const [key, rawValue] = param.split("=").map((item) => item.trim());
    if (!rawValue) {
      continue;
    }

    const numericValue = Number.parseInt(rawValue, 10);
    if (Number.isNaN(numericValue)) {
      continue;
    }

    if (key === "rate") {
      overrides.sampleRate = numericValue;
    }

    if (key === "channels") {
      overrides.numChannels = numericValue;
    }
  }

  return { ...defaults, ...overrides };
}

export function createWavHeader(
  dataLength: number,
  options: WavConversionOptions
): Buffer {
  const { numChannels, sampleRate, bitsPerSample } = options;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  const buffer = Buffer.alloc(44);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);

  return buffer;
}

function mergeWavBuffers(buffers: Buffer[]): Buffer {
  if (!buffers.length) {
    throw new Error("No wav buffers to merge.");
  }

  const [firstBuffer, ...rest] = buffers;
  if (!firstBuffer) {
    throw new Error("Missing primary wav buffer.");
  }

  const headerSize = 44;
  if (firstBuffer.length < headerSize) {
    throw new Error("Invalid wav buffer received from Gemini.");
  }

  const dataSections = [
    firstBuffer.subarray(headerSize),
    ...rest.map((buffer) => buffer.subarray(headerSize)),
  ];
  const totalDataLength = dataSections.reduce(
    (sum, chunk) => sum + chunk.length,
    0
  );

  const merged = Buffer.concat([
    firstBuffer.subarray(0, headerSize),
    ...dataSections,
  ]);
  merged.writeUInt32LE(36 + totalDataLength, 4);
  merged.writeUInt32LE(totalDataLength, 40);

  return merged;
}
