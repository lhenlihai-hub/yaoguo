# 腰果终端版 — AGENTS.md

## Commands

| Command | What |
|---|---|
| `npm run cli` | Launch interactive terminal Agent |
| `npm run check` | Syntax, architecture, prompt hygiene and regression checks |
| `npm run typecheck` | Type-check opted-in JavaScript with `tsc --noEmit` |
| `npm test` | Run the Node test suite |
| `npm run test:coverage` | Generate text, HTML and JSON coverage reports |

Always run `npm run check` before `npm test`.

## Architecture

- `src/cli/` is the terminal entry point.
- `src/application/` owns orchestration and workflows.
- `src/platform/` owns the Agent loop, DeepSeek adapter, tools, memory, context, runs and artifacts.
- `src/app/shell/bridgeService.js` is the Node host bridge used by the application composition root.
- `workspace/workflows/` and `workspace/registries/` contain bundled workflow, prompt and Skill assets.

Keep one Agent loop in `src/platform/ai/agentLoop/agentLoop.js`. Reuse Pi's loop, validation hooks, basic tools and Skill loading; add product behavior in the application or platform layer, not in a second engine.

The architecture check keeps `workflowEngine.js` < 2230 lines and applies per-function complexity redlines to application and platform code.

## Project hygiene

- Never commit build output, runtime data, local configuration, logs or coverage.
- Keep DeepSeek as the only model provider and route model calls through `ModelGateway`.
- Register prompts as assets instead of adding large inline prompt blocks.
- Use measurable execution constraints. `soul` and `aesthetic.baseline` are the only philosophical assets.
- Runtime API keys belong in `DEEPSEEK_API_KEY` or ignored local settings, never source files or CLI arguments.
- Preserve the order `check`, `typecheck`, `test` before committing.

## Runtime

Source is CommonJS `.js`; tests are ESM `.mjs`. TypeScript checking is incremental through `// @ts-check` and `tsc --noEmit`.

Session Memory compacts at 100,000 active tokens. Oversized first-turn input and tool results are externalized losslessly. Active long-term memory uses the Agent-bound Memdir.
