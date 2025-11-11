import "dotenv/config";

async function bootstrap() {
  try {
    const { startServer } = await import("./src/server.ts");
    await startServer();
  } catch (error) {
    console.error("Unable to start the server:", error);
    process.exit(1);
  }
}

bootstrap();
