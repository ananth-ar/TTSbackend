import os from "node:os";
import cors from "cors";
import express, { type Express } from "express";

import { HOST, OUTPUT_DIR, PORT } from "./config.ts";
import ttsRoutes from "./routes/ttsRoutes.ts";
import { ensureDirectory } from "./utils/fs.ts";

function getNetworkUrls(port: number): string[] {
  const interfaces = os.networkInterfaces();
  const urls: string[] = [];

  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const address of iface) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${port}`);
      }
    }
  }

  return urls;
}

export async function createApp(): Promise<Express> {
  await ensureDirectory(OUTPUT_DIR);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api", ttsRoutes);

  return app;
}

export async function startServer(): Promise<void> {
  const app = await createApp();

  await new Promise<void>((resolve) => {
    app.listen(PORT, HOST, () => {
      console.log("Text-to-speech server listening:");
      console.log(`- Local: http://localhost:${PORT}`);

      if (HOST !== "0.0.0.0" && HOST !== "::") {
        console.log(`- Host: http://${HOST}:${PORT}`);
      } else {
        const networkUrls = getNetworkUrls(PORT);
        if (networkUrls.length > 0) {
          for (const url of networkUrls) {
            console.log(`- Network: ${url}`);
          }
        }
      }
      resolve();
    });
  });
}
