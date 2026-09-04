# 0014 — Run the add-on's TypeScript source directly via Node type stripping

Status: accepted (2026-09-04).

## Context

Every code change used to require a `tsc` build before the server could run:
`native-server.mjs` imported `addon/dist/index.js`, the start scripts ran
`npm run build` first, and the documented dev loop needed two terminals
(`tsc --watch` plus `node --watch dist/`). `node src/index.ts` did not work
because source files imported each other with `.js` specifiers, which Node's
type stripping does not remap.

We want a loop where a saved file is the next restart, and a way to run the
server from a checkout without building or installing the app.

## Options considered

1. **Node's built-in type stripping** (unflagged since 22.18). Zero new
   dependencies, but it only erases syntax — it cannot compile `enum`,
   `namespace`, parameter properties, or value imports of types — and it
   requires explicit `.ts` import specifiers.
2. **`tsx` as a devDependency.** Handles `.js` → `.ts` remapping and every
   TypeScript feature, but adds an esbuild-based toolchain to a project whose
   working agreement is to prefer Node built-ins and to ask before adding
   dependencies.
3. **Keep `tsc --watch`, only skip the one-shot build in the start scripts.**
   Smallest change, but still two processes and a compile in the loop.

## Decision

Option 1. The add-on source is kept runnable by Node with no compiler:

- Relative imports use `.ts` specifiers. `tsconfig.json` sets
  `rewriteRelativeImportExtensions` (so `dist/` still gets `.js`) and
  `allowImportingTsExtensions`.
- `erasableSyntaxOnly` and `verbatimModuleSyntax` are enabled so `tsc`
  rejects any syntax type stripping cannot handle. The eleven constructors
  that used parameter properties were rewritten as explicit fields.
- `native-server.mjs` accepts `--dev` and then imports `addon/src/index.ts`
  instead of `addon/dist/index.js`; `start-native.sh` / `start-native.ps1
--dev` skip the build and forward the flag. `npm run dev` runs
  `src/index.ts` under `node --watch`; `npm run dev:native` does the same for
  the whole supervisor.
- `engines.node` is raised to `>=22.18`, the first release with type
  stripping on by default.

Packaged bundles are unchanged: they ship `dist/` only and never pass `--dev`.

## Consequences

- One process, no compile step, in the dev loop. A checkout can run the full
  server headless with `scripts/start-native.sh --dev`.
- `.ts` specifiers are unusual to readers used to the `.js` convention; the
  guide explains why. The management UI's browser modules under
  `assets/manage/` are plain JavaScript and keep `.js`.
- Future code must stay within erasable syntax; `tsc --noEmit` fails
  otherwise, so the constraint is caught at typecheck time, not at runtime.
- Node prints no warning for `.ts` entry points on 22.18+/24+/26; older 22.x
  would need `--experimental-strip-types`, which the engines field now
  excludes.
