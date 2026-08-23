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

## Fast dev loop (no Docker, no app build)

```bash
cp ../.env.example ../.env    # once; set ACCESS_TOKEN and the URLs
npm run dev:tsc               # terminal 1: tsc --watch
npm run dev                   # terminal 2: node --watch --env-file=.env dist/index.js
```

The server restarts automatically when `dist/` changes; management-UI assets
(`assets/manage/`) are served from disk, so UI edits need only a browser
refresh. Note that `node src/index.ts` does not work directly — source
imports use `.js` specifiers, which Node's type stripping does not remap.

Note: when testing the built menu-bar app instead, it reads its own `.env`
from the state dir (`~/Library/Application Support/HoshiStream/.env`), not
the repo's.

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
