# ttsbackend

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.1. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## API

`POST /api/tts`

```json
{
  "text": "Hello from Codex",
  "voiceName": "Fenrir",
  "fileName": "greeting-intro"
}
```

- `text` (string, required): content to convert to audio.
- `voiceName` (string, optional): Gemini prebuilt voice to use.
- `fileName` (string, optional): desired audio file name (extension is derived from the generated mime type). When omitted, a unique timestamp-based name is used.
