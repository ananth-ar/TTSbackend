import { Router } from "express";
import type { Request, Response } from "express";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_WORD_COUNT, OUTPUT_DIR } from "../config.ts";
import { processLlmTextProcessingJob } from "../services/llmTextProcessingService.ts";
import { countWords } from "../utils/text.ts";

const router = Router();

router.get("/audio", async (_req: Request, res: Response) => {
  try {
    console.log("GET /audio");
    const entries = await readdir(OUTPUT_DIR, { withFileTypes: true });
    const fileNames = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    res.json({ files: fileNames });
  } catch (error) {
    console.error("Failed to list audio files:", error);
    res.status(500).json({ error: "Unable to list audio files." });
  }
});

router.get("/audio/:fileName", async (req: Request, res: Response) => {
  try {
    console.log("GET /audio/:fileName");
    const requestedName =
      typeof req.params.fileName === "string" ? req.params.fileName : "";
    if (!requestedName) {
      res.status(400).json({ error: "Audio file name is required." });
      return;
    }

    const safeName = path.basename(requestedName);
    const filePath = path.join(OUTPUT_DIR, safeName);

    if (!existsSync(filePath)) {
      res.status(404).json({ error: "Audio file not found." });
      return;
    }

    console.log("Sending file:", filePath);
    res.sendFile(filePath);
  } catch (error) {
    console.error("Failed to serve audio file:", error);
    res.status(500).json({ error: "Unable to serve audio file." });
  }
});

router.post("/tts", async (req: Request, res: Response) => {
  console.log("POST /tts");
  const { text, voiceName, fileName } = req.body as {
    text?: unknown;
    voiceName?: unknown;
    fileName?: unknown;
  };

  if (typeof text !== "string" || text.trim().length === 0) {
    res.status(400).json({ error: "The `text` field is required." });
    return;
  }

  const normalizedText = text.trim();
  const wordCount = countWords(normalizedText);
  if (wordCount > MAX_WORD_COUNT) {
    res.status(400).json({
      error: `Text exceeds the ${MAX_WORD_COUNT} word limit.`,
      wordCount,
    });
    return;
  }

  if (voiceName !== undefined && typeof voiceName !== "string") {
    res
      .status(400)
      .json({ error: "`voiceName` must be a string when provided." });
    return;
  }

  if (fileName !== undefined) {
    if (typeof fileName !== "string") {
      res
        .status(400)
        .json({ error: "`fileName` must be a string when provided." });
      return;
    }

    if (!fileName.trim()) {
      res
        .status(400)
        .json({ error: "`fileName` cannot be empty when provided." });
      return;
    }
  }

  const jobId = randomUUID();
  const requestedFileName =
    typeof fileName === "string" ? fileName.trim() : undefined;
  const selectedVoice = typeof voiceName === "string" ? voiceName : undefined;

  console.log(`[Job ${jobId}] Dispatching llmtextprocessing job.`);
  processLlmTextProcessingJob({
    text: normalizedText,
    voiceName: selectedVoice,
    requestedFileName,
    jobId,
  })
    .then((result) => {
      if (result.audio) {
        console.log(
          `[Job ${jobId}] Completed. SSML file: ${result.ssmlFileName}, Audio file: ${result.audio.fileName}.`
        );
      } else {
        console.log(
          `[Job ${jobId}] Completed with SSML only. File: ${result.ssmlFileName}.`
        );
      }
    })
    .catch((error) => {
      console.error(`[Job ${jobId}] llmtextprocessing pipeline failed.`, error);
    });

  res.status(202).json({
    message: "llmtextprocessing job started.",
    jobId,
  });
});

export default router;
