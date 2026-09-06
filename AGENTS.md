# AGENTS.md

Instructions for AI coding agents working in this repository.

## Project Overview

HoshiStream is a private, local-first Stremio-compatible add-on for Nuvio: a Node 22 + TypeScript server that keeps a personal JSON library, asks a pinned TorrServer to inspect authorized torrents, and returns direct-play URLs. It runs as a native app — a macOS menu-bar supervisor today, Windows next. There are no containers ([ADR 0009](hoshistream_docs/decisions/0009-native-only-deployment.md)).

## Working Agreement (required)

- Implement only the requested phase.
- Verify TorrServer behavior against its source or Swagger before adding API calls.
- Keep media legal, local-first, direct-play, and private by default.
- In-app torrent discovery is retired (ADR 0020). Keep media adding manual, with the Chrome companion as a user-triggered capture/review bridge. Do not reintroduce provider search, scraping, challenge bypass, or generic Torznab without approval. Do not add transcoding, a database, a dashboard, or containers.
- Never log access tokens, authorization headers, or complete magnet URIs.
- Run type checks, tests, lint, and format checks before finishing.

## Documentation Workflow (required)

All project documentation lives in the dedicated docs folder at the repository root:

```
hoshistream_docs/
```

Start at `hoshistream_docs/index.md`.

Structure the folder with these subfolders:

```
hoshistream_docs/
├── index.md          # Lists every doc with a one-line description
├── architecture/     # System design, diagrams, data models
├── decisions/        # ADRs — what was decided and why
├── guides/           # Setup, how-tos, onboarding
├── api/              # API and interface references
├── plans/            # Feature plans, task breakdowns, roadmaps
└── changelog/        # Notable change summaries per release/feature
```

Rules:
1. If the folder (or a needed subfolder) does not exist yet, create it before writing any documentation.
2. Place ALL generated docs there — plans, architecture notes, API references, changelogs, decision records. Do not scatter markdown files elsewhere in the repo.
3. Use clear, kebab-case file names (e.g. `architecture-overview.md`, `api-reference.md`).
4. Keep `index.md` up to date whenever you add, move, or remove a doc.
5. Update existing docs instead of creating duplicates.
6. Name decision records `NNNN-short-title.md` (e.g. `0003-switch-to-postgres.md`) and never edit an accepted ADR — supersede it with a new one.
7. Date plan documents (e.g. `2026-08-10-auth-refactor-plan.md`) so stale plans are easy to identify.

## Setup

```bash
cd addon
npm ci
```

Running the full stack (optional for most code changes): copy `.env.example` to `.env`, set `ACCESS_TOKEN` and `MEDIA_DIR`, then build and launch the native app. See `hoshistream_docs/guides/setup-native-macos.md`.

## Build & Test

Run from `addon/` to validate changes:

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
```

The optional TorrServer integration test is opt-in: `TORRSERVER_TEST_URL=http://127.0.0.1:8090 npm test`. It checks only health and an empty list; it downloads no media.

## Code Style & Conventions

- Strict TypeScript, ESM (`"type": "module"`), Node 22 built-ins over new dependencies.
- Prettier formats everything; ESLint (flat config + typescript-eslint) must pass clean.
- Validate every external boundary with Zod: environment config, HTTP request bodies, TorrServer responses.
- Structured JSON logs (`level`, `event`, context) to stdout/stderr — never tokens, auth headers, or magnet URIs.
- Tests mirror source modules in `addon/tests/*.test.ts` (Vitest).
- Runtime dependencies are `stremio-addon-sdk`, `zod`, and `bencode` (with `uint8-util`). Ask before adding more. The Chrome companion uses browser APIs; do not add a browser automation runtime.

## Workflow Best Practices

- **Plan before coding.** For non-trivial tasks, write a short plan in `plans/` first and follow it.
- **Make small, focused changes.** One logical change per commit; don't mix refactors with features.
- **Verify before declaring done.** Run the build and tests after every change. A task isn't complete until they pass.
- **Read before writing.** Inspect existing code and follow its patterns rather than introducing new ones.
- **Prefer editing over rewriting.** Make surgical changes; don't regenerate whole files.
- **Leave the codebase consistent.** Update related docs, tests, and comments affected by your change.
- **Document as you go.** Record significant decisions in `decisions/` and summarize completed work in `changelog/`.
- **Ask when uncertain.** If requirements are ambiguous or a change is risky/destructive, stop and ask instead of guessing.

## Git Conventions

- Write clear commit messages: short imperative summary, blank line, then the "why".
- Never force-push or rewrite shared history.
- Never commit directly to `main` unless explicitly told to.

## Boundaries

- Do not commit secrets, credentials, or `.env` files.
- Do not modify files outside the scope of the task without asking.
- Ask before adding new dependencies.
- Do not delete or overwrite user data, migrations, or lockfiles without confirmation.
