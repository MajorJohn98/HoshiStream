# Development

The add-on lives in `addon/` (Node 22.18+, TypeScript, ESM). No database - state uses atomic JSON files.

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
Node 22.18 or newer is required for source mode. The independently pinned app
runtime is currently Node v26.3.1 (`packaging/node-lock.json`); do not describe
the shipped runtime as Node 22.

Add-on only (TorrServer must already be running; uses the repo `.env`):

```bash
cp ../.env.example ../.env    # once; set ACCESS_TOKEN and the URLs
npm run dev                   # node --watch --env-file=../.env src/index.ts
```

Whole native stack — TorrServer + add-on, exactly what the menu-bar app
supervises, minus the menu bar:

```bash
npm run dev:native            # restarts on any change under src/ or scripts/
```

For a foreground run without watching, from the **repository root** on either
macOS or Windows x64:

```text
node packaging/fetch-torrserver.mjs
node packaging/fetch-ffmpeg.mjs
node scripts/native-server.mjs --dev
```

Run `npm ci` in `addon/` first. Fetchers choose the host platform; the ffmpeg
fetch also supplies ffprobe. Keep the terminal open and use Ctrl+C to request
shutdown. A fresh checkout gets a generated root `.env`; existing values are
preserved, so correct any media paths copied from another computer.
Open `http://127.0.0.1:7001/manage/<ACCESS_TOKEN>` with its generated token and
configured port. Read `.env` privately in a local editor; do not print it into
shared logs or publish the tokenized management URL.

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

The same checkout state applies to `node scripts/native-server.mjs --dev`.
The launcher now pins all JSON store paths there, including tags, devices,
storage volumes and scheduling. Browser-uploaded media is in the checkout's
`data/media/`; it is not in `native-data/`. The checkout `.env` contains private
configuration/credentials and uses `MEDIA_DIR` for linked local media.

| Mode | Configuration | Library / JSON state | Managed uploads |
|---|---|---|---|
| Foreground / watch checkout | `<checkout>/.env` | `<checkout>/native-data/` | `<checkout>/data/media/` |
| Installed macOS / `start-native.sh` | `~/Library/Application Support/HoshiStream/.env` | `~/Library/Application Support/HoshiStream/` | `~/Library/Application Support/HoshiStream/data/media/` |

Linked originals stay in their selected folders. Custom roots can change these
paths; this table describes the defaults, not a full backup inventory.
For backups, include the checkout `.env`, `native-data/` and `data/` as separate
stopped-copy locations, plus linked originals/storage roots separately. The
[installed-app restore block](backup-restore-updates.md) does not cover this
split layout by itself.
Terminal mode does not create a native tray, Finder file-picker bridge or Chrome
companion registration. The Windows desktop shell is a separate .NET project;
see [setup-native-windows.md](setup-native-windows.md).

Start scripts confirm the launched runtime's identity and actual readiness,
not merely a PID file. Stop scripts use private local authenticated control
to drain work; they do not blindly terminate a PID. State must live on a
local filesystem supporting private permissions and atomic hard links.
See [native runtime control](../api/native-runtime-control.md).

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

An isolated native startup/shutdown smoke test uses the pinned local binary,
temporary state and separate service/peer ports. It registers no torrents:

```text
node scripts/smoke-native.mjs --dev
cd addon
npm run build
cd ..
node scripts/smoke-native.mjs --control-stop
```

For an isolated packaged-runtime check without copying a smoke harness into the
release app, run from the repository root after building:

```bash
RUNTIME="$PWD/build/HoshiStream.app/Contents/Resources/runtime"
PATH=/usr/bin:/bin:/usr/sbin:/sbin "$RUNTIME/bin/node" \
  scripts/smoke-native.mjs --runtime-root="$RUNTIME" --control-stop
```

The harness creates temporary state and alternate ports and leaves installed
state untouched. It downloads no media and does not establish real-device or
sustained playback acceptance.

Use [the candidate acceptance runbook](closed-beta-acceptance.md) to record
artifact identity and distinguish this local evidence from recipient results.
The [recovery procedure](backup-restore-updates.md) is exercised directly by
`tests/recovery-workflow.test.ts` on macOS; no private state or media downloads
are used.

## Working agreement (AGENTS.md)

- Implement only the requested phase.
- Verify TorrServer behavior against its source or Swagger before adding API calls ([ADR 0001](../decisions/0001-torrserver-matrix-141-pinning.md)).
- Keep media legal, local-first, direct-play, and private by default.
- In-app discovery is retired (ADR 0020). Keep adding manual, with the Chrome companion as an explicit capture/review bridge. Do not reintroduce provider search, scraping, challenge bypass, transcoding, a database, or a dashboard without approval.
- HoshiStream runs natively; do not reintroduce containers ([ADR 0009](../decisions/0009-native-only-deployment.md)).
- Never log access tokens, authorization headers, or complete magnet URIs.
- Run type checks, tests, lint, and format checks before finishing.

## Conventions

- Strict TypeScript, ESM modules, Zod validation at every external boundary (env, HTTP bodies, TorrServer responses).
- Structured JSON logs to stdout/stderr (`level`, `event`, context fields).
- Tests mirror source modules in `addon/tests/*.test.ts` (Vitest).
- Formatting is Prettier-enforced; lint is flat-config ESLint + typescript-eslint.
- Dependencies are minimal (`stremio-addon-sdk`, `zod`, `bencode`); ask before adding more.
