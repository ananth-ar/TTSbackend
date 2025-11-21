import path from "node:path";
import { appendFile, readFile, writeFile } from "node:fs/promises";

import { OUTPUT_DIR } from "../../config.ts";
import { ensureDirectory } from "../../utils/fs.ts";
import type { GeminiTtsGenerationMode } from "./types.ts";

type GeminiLogMode = GeminiTtsGenerationMode | "batch";

interface GeminiLogBase {
  mode: GeminiLogMode;
  label: string;
  tokens?: number;
  requestBytes?: number;
  responseBytes?: number;
}

export interface GeminiRequestLog extends GeminiLogBase {}

export interface GeminiResponseLog extends GeminiLogBase {
  status: "success" | "failure";
  error?: string;
}

interface GeminiRequestEvent extends GeminiRequestLog {
  kind: "request";
}

interface GeminiResponseEvent extends GeminiResponseLog {
  kind: "response";
}

type GeminiLogEvent = GeminiRequestEvent | GeminiResponseEvent;

interface DailyTotals {
  requests: number;
  successes: number;
  failures: number;
  tokens: number;
  requestBytes: number;
  responseBytes: number;
}

const totalsCache = new Map<string, DailyTotals>();
const dayQueues = new Map<string, Promise<void>>();

export async function logGeminiRequest(event: GeminiRequestLog): Promise<void> {
  try {
    await writeLog({ ...event, kind: "request" });
  } catch (error) {
    console.warn("[Gemini][log] Failed to record request log entry.", error);
  }
}

export async function logGeminiResponse(event: GeminiResponseLog): Promise<void> {
  try {
    await writeLog({ ...event, kind: "response" });
  } catch (error) {
    console.warn("[Gemini][log] Failed to record response log entry.", error);
  }
}

async function writeLog(event: GeminiLogEvent): Promise<void> {
  const dayKey = formatDayKey(new Date());
  const previous = dayQueues.get(dayKey) ?? Promise.resolve();
  const next = previous.then(async () => {
    const timestamp = new Date();
    await ensureDirectory(OUTPUT_DIR);

    const logFilePath = getLogFilePath(dayKey);
    const totals = await loadDailyTotals(dayKey);

    if (event.kind === "request") {
      totals.requests += 1;
      totals.tokens += event.tokens ?? 0;
      totals.requestBytes += event.requestBytes ?? 0;
    } else {
      if (event.status === "success") {
        totals.successes += 1;
      } else {
        totals.failures += 1;
      }
      totals.responseBytes += event.responseBytes ?? 0;
    }

    const timestampIso = timestamp.toISOString();
    const line = formatEventLine(timestampIso, event);

    await appendFile(logFilePath, `${line}\n`, {
      encoding: "utf8",
    });
    await saveDailyTotals(dayKey, totals);
  });

  dayQueues.set(
    dayKey,
    next.catch(() => {
      /* swallow to keep chain alive */
    })
  );

  return next;
}

function formatDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getLogFilePath(dayKey: string): string {
  return path.join(OUTPUT_DIR, `gemini-audio-${dayKey}.txt`);
}

function getSummaryPath(dayKey: string): string {
  return path.join(OUTPUT_DIR, "gemini-audio-summary.json");
}

function formatEventLine(timestamp: string, event: GeminiLogEvent): string {
  const parts = [
    timestamp,
    event.kind === "request"
      ? "REQ"
      : `RES-${event.status === "success" ? "OK" : "ERR"}`,
    `mode=${event.mode}`,
    `label=${sanitize(event.label)}`,
  ];

  if (event.tokens !== undefined) {
    parts.push(`tokens=${event.tokens}`);
  }
  if (event.requestBytes !== undefined) {
    parts.push(`reqBytes=${event.requestBytes}`);
  }
  if (event.responseBytes !== undefined) {
    parts.push(`respBytes=${event.responseBytes}`);
  }
  if (event.kind === "response" && event.error) {
    parts.push(`err=${sanitize(event.error)}`);
  }

  return parts.join(" | ");
}

async function loadDailyTotals(dayKey: string): Promise<DailyTotals> {
  const cached = totalsCache.get(dayKey);
  if (cached) {
    return { ...cached };
  }

  const summaryMap = await loadSummaryMap();
  const existing = summaryMap[dayKey];
  if (existing) {
    const totals: DailyTotals = {
      requests: Number.isFinite(existing.requests) ? existing.requests : 0,
      successes: Number.isFinite(existing.successes) ? existing.successes : 0,
      failures: Number.isFinite(existing.failures) ? existing.failures : 0,
      tokens: Number.isFinite(existing.tokens) ? existing.tokens : 0,
      requestBytes: Number.isFinite(existing.requestBytes)
        ? existing.requestBytes
        : 0,
      responseBytes: Number.isFinite(existing.responseBytes)
        ? existing.responseBytes
        : 0,
    };
    totalsCache.set(dayKey, totals);
    return { ...totals };
  }

  const defaults: DailyTotals = {
    requests: 0,
    successes: 0,
    failures: 0,
    tokens: 0,
    requestBytes: 0,
    responseBytes: 0,
  };
  totalsCache.set(dayKey, defaults);
  return { ...defaults };
}

async function saveDailyTotals(
  dayKey: string,
  totals: DailyTotals
): Promise<void> {
  totalsCache.set(dayKey, { ...totals });
  const summaryMap = await loadSummaryMap();
  summaryMap[dayKey] = { date: dayKey, ...totals };
  await writeFile(getSummaryPath(dayKey), JSON.stringify(summaryMap), {
    encoding: "utf8",
  });
}

async function loadSummaryMap(): Promise<
  Record<string, DailyTotals & { date: string }>
> {
  try {
    const raw = await readFile(getSummaryPath(""), { encoding: "utf8" });
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, DailyTotals & { date: string }>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function sanitize(value: unknown): string {
  if (value === undefined || value === null) {
    return "-";
  }

  const normalized = String(value)
    .replace(/\s+/g, " ")
    .replace(/[|]/g, "/")
    .trim();

  return normalized.slice(0, 240) || "-";
}
