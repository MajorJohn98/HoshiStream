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

Optional TorrServer integration test (health + empty list only; downloads nothing):

```bash
TORRSERVER_TEST_URL=http://127.0.0.1:8090 npm test
```

Validate compose configuration from the repo root:

```bash
docker compose config -q     # or: docker-compose config -q
```

## Working agreement (AGENTS.md)

- Implement only the requested phase.
- Verify TorrServer behavior against its source or Swagger before adding API calls ([ADR 0001](../decisions/0001-torrserver-matrix-141-pinning.md)).
- Keep media legal, local-first, direct-play, and private by default.
- Do not add torrent search, transcoding, a database, or a dashboard.
- Never log access tokens, authorization headers, or complete magnet URIs.
- Run type checks and Docker Compose validation before finishing.

## Conventions

- Strict TypeScript, ESM modules, Zod validation at every external boundary (env, HTTP bodies, TorrServer responses).
- Structured JSON logs to stdout/stderr (`level`, `event`, context fields).
- Tests mirror source modules in `addon/tests/*.test.ts` (Vitest).
- Formatting is Prettier-enforced; lint is flat-config ESLint + typescript-eslint.
- Dependencies are minimal (`stremio-addon-sdk`, `zod`); ask before adding more.
