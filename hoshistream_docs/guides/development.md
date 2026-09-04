# Development

The add-on lives in `addon/` (Node 22, TypeScript, ESM). No database — state is one atomically-written JSON file.

## Commands

```bash
cd addon
npm ci
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run lint           # eslint
npm run format:check   # prettier
npm run build          # tsc → dist/
```

## Fast dev loop (no app build, no tsc)

The add-on runs straight from `src/` — Node strips the types at load time, so
there is no build step in the loop ([ADR 0014](../decisions/0014-run-typescript-source-directly.md)).
Node 22.18 or newer is required; the vendored runtime is far past that.

Add-on only (TorrServer must already be running; uses the repo `.env`):

```bash
cp ../.env.example ../.env    # once; set ACCESS_TOKEN and the URLs
npm run dev                   # node --watch --env-file=.env src/index.ts
```

Whole native stack — TorrServer + add-on, exactly what the menu-bar app
supervises, minus the menu bar:

```bash
npm run dev:native            # restarts on any change under src/ or scripts/
```

or, detached to the state directory like the packaged app does:

```bash
../scripts/start-native.sh --dev      # macOS
..\scripts\start-native.ps1 --dev     # Windows
```

`--dev` skips `npm run build` and makes `native-server.mjs` import
`addon/src/index.ts` instead of `addon/dist/index.js`. Without it, the start
scripts build first, which is also how you run the server headless without
installing the app.

The two whole-stack commands differ in whose data they use:

- `start-native.sh` / `start-native.ps1` are a drop-in for the installed app:
  same state dir (`~/Library/Application Support/HoshiStream`, or
  `%LOCALAPPDATA%\HoshiStream`), same `.env`, same token — so your real
  library, TorrServer cache, and client URLs carry over. Quit the app first;
  they share ports. Stop with `stop-native.sh` / `stop-native.ps1`.
- `npm run dev:native` is a sandbox: it reads the repo `.env` and keeps its
  state in the gitignored `native-data/`, so experiments never touch the
  installed app's library.

Management-UI assets (`assets/manage/`) are served from disk, so UI edits need
only a browser refresh.

Two rules keep source runnable without a compiler, both enforced by `tsc`:

- Relative imports use `.ts` specifiers (`from "./library.ts"`);
  `rewriteRelativeImportExtensions` turns them into `.js` in `dist/`.
- Only erasable TypeScript syntax: no `enum`, `namespace`, or constructor
  parameter properties (`constructor(private x: T)`), and type-only imports
  must be `import type` (`erasableSyntaxOnly` + `verbatimModuleSyntax`).

Note: when testing the built menu-bar app instead, it reads its own `.env`
from the state dir (`~/Library/Application Support/HoshiStream/.env`), not
the repo's. Only one TorrServer can hold the BitTorrent peer port (32001), so
quit the installed app before running the dev stack.

Optional TorrServer integration test (health + empty list only; downloads nothing):

```bash
TORRSERVER_TEST_URL=http://127.0.0.1:8090 npm test
```

## Working agreement (AGENTS.md)

- Implement only the requested phase.
- Verify TorrServer behavior against its source or Swagger before adding API calls ([ADR 0001](../decisions/0001-torrserver-matrix-141-pinning.md)).
- Keep media legal, local-first, direct-play, and private by default.
- Do not add torrent search, transcoding, a database, or a dashboard.
- HoshiStream runs natively; do not reintroduce containers ([ADR 0009](../decisions/0009-native-only-deployment.md)).
- Never log access tokens, authorization headers, or complete magnet URIs.
- Run type checks, tests, lint, and format checks before finishing.

## Conventions

- Strict TypeScript, ESM modules, Zod validation at every external boundary (env, HTTP bodies, TorrServer responses).
- Structured JSON logs to stdout/stderr (`level`, `event`, context fields).
- Tests mirror source modules in `addon/tests/*.test.ts` (Vitest).
- Formatting is Prettier-enforced; lint is flat-config ESLint + typescript-eslint.
- Dependencies are minimal (`stremio-addon-sdk`, `zod`); ask before adding more.
