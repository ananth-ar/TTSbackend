# Repository Guidelines

## Project Structure & Module Organization
The entry point is `index.ts`, which boots `src/server.ts` and wires Express routes from `src/routes`, service logic from `src/services`, and formatting helpers in `src/utils`. Configuration, API client wiring, and rate limits live in `src/config.ts`. Audio artifacts are written to `output/` (created on demand); keep large files out of git. Tests are colocated with code when introduced—mirror the folder you cover (`src/services/__tests__/processTexttoSpeechService.test.ts`, for example).

## Build, Development Commands
- `bun install` – install dependencies declared in `package.json` (prefer Bun to keep lockfiles aligned).
- `bun run index.ts` – start the API once, matching the README quick-start.
- `bun run dev` – watch mode via `tsx watch index.ts`; restarts on file saves.
- `bun run typecheck` – run `tsc --noEmit` to ensure contracts stay sound before pushing.
Use `curl -X POST http://localhost:3000/api/tts -d '{"text":"Hello","voiceName":"Fenrir"}' -H 'Content-Type: application/json'` to verify the `/api/tts` route produces audio and metadata.

## Coding Style & Naming Conventions
TypeScript modules are ESNext (`type: module`), so use explicit file extensions in relative imports. Follow the existing two-space indentation, camelCase for functions/vars, PascalCase for classes/types, and SCREAMING_SNAKE_CASE for config constants. Keep services pure and reusable; routes should only orchestrate request parsing, service calls, and responses. Run `bun run typecheck` plus your editor’s formatter (VSCode default or `bunx prettier` if installed) before committing.

## Commit & Pull Request Guidelines
History favors imperative, descriptive messages such as `Add support for TTS generation mode configuration`. Keep the subject <72 chars, start with a capital verb, and omit trailing periods. PRs should include: purpose summary, notable config/env changes (`GEMINI_API_KEY`, `SSML_SYSTEM_PROMPT`, etc.), test evidence (commands plus sample output), and any follow-up TODOs.

## Security & Configuration Tips
Create a `.env` file (ignored by git) defining `GEMINI_API_KEY`, `OPENAI_API_KEY`, `HF_TOKEN`, `SSML_SYSTEM_PROMPT`, and port/rate-limit overrides. Never log secrets; prefer referencing sanitized IDs. When debugging, redact payloads before pasting in issues, and reset keys if they were ever committed.
