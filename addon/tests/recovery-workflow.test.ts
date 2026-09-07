import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ensureFirstRunSetup, parseEnvFile } from "../../scripts/bootstrap.mjs";
import { claimRuntimeState } from "../../scripts/native-runtime.mjs";
import { ArchiveSchedule } from "../src/archive-schedule.ts";
import { Library } from "../src/library.ts";
import { Onboarding } from "../src/onboarding.ts";
import { PointerClient } from "../src/pointer.ts";
import { Tags } from "../src/tags.ts";
import { libraryEntrySchema } from "../src/types.ts";
import { MARKER_FILENAME, VolumeRegistry } from "../src/volumes.ts";

const execute = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const guide = join(root, "hoshistream_docs/guides/backup-restore-updates.md");
const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function put(root: string, path: string, contents: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents, { mode: 0o600 });
}

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hoshi-recovery-")));
  temporary.push(base);
  const state = join(base, "Application Support", "HoshiStream");
  const original = join(base, "linked originals", "movie.mp4");
  const volumeRoot = join(base, "Volumes", "Disk", "HoshiStream");
  await put(base, "linked originals/movie.mp4", "synthetic linked bytes");
  await mkdir(volumeRoot, { recursive: true });
  const setup = await ensureFirstRunSetup({
    projectRoot: state,
    mediaDir: dirname(original),
  });
  const volumes = new VolumeRegistry(
    join(state, "volumes.json"),
    join(base, "Volumes"),
  );
  const volume = await volumes.register(volumeRoot);
  await put(volumeRoot, "series/episode.mp4", "synthetic archived bytes");
  await put(state, "data/media/upload.mp4", "synthetic uploaded bytes");
  await put(
    state,
    "data/media/source.torrent",
    "synthetic torrent bytes; never submitted",
  );
  const now = new Date().toISOString();
  const entries = [
    {
      id: "hoshi:linked",
      name: "Synthetic linked movie",
      type: "movie",
      localFilePath: original,
      tags: ["Drama"],
      playback: { positionSeconds: 42, source: "browser", updatedAt: now },
    },
    {
      id: "hoshi:uploaded",
      name: "Synthetic upload",
      type: "movie",
      localFilePath: join(state, "data/media/upload.mp4"),
      managedMedia: true,
    },
    {
      id: "hoshi:series",
      name: "Synthetic series",
      type: "series",
      torrentFilePath: join(state, "data/media/source.torrent"),
      managedMedia: true,
      extraSources: [{ magnetUri: `magnet:?xt=urn:btih:${"b".repeat(40)}` }],
      inspectionCache: {
        hash: "a".repeat(40),
        inspectedAt: now,
        selectedFiles: [
          { id: 1, path: "S01E01.mp4", length: 24, season: 1, episode: 1 },
          {
            id: 2,
            path: "S02E01.mp4",
            length: 24,
            season: 2,
            episode: 1,
            hash: "b".repeat(40),
          },
        ],
      },
      diskCopy: {
        desired: "keep",
        volumeId: volume.id,
        relativeDir: "series",
        sourceRevision: "synthetic-revision",
        scope: "selected",
        paused: true,
        files: [
          {
            sourceKey: `${"a".repeat(40)}:1`,
            relativePath: "episode.mp4",
            length: 24,
            included: true,
            state: "complete",
          },
        ],
        updatedAt: now,
      },
    },
  ].map((entry) =>
    libraryEntrySchema.parse({ ...entry, createdAt: now, updatedAt: now }),
  );
  await put(state, "library.json", JSON.stringify(entries));
  await put(state, "library.json.bak", JSON.stringify(entries));
  await new Tags(join(state, "tags.json")).ensure(["Drama"]);
  await new Onboarding(join(state, "onboarding.json"), true).update(
    { action: "dismiss" },
    true,
  );
  await new ArchiveSchedule(join(state, "disk-schedule.json")).set({
    startMinute: 60,
    endMinute: 120,
  });
  await put(
    state,
    "pointer-settings.json",
    JSON.stringify({ enabled: true, pointerUrl: "https://pointer.example" }),
  );
  await put(
    state,
    "pointer-state.json",
    JSON.stringify({
      version: 2,
      pointerUrl: "https://pointer.example",
      tokenHash: createHash("sha256")
        .update(setup.environment.ACCESS_TOKEN)
        .digest("hex"),
      pushSecretHash: createHash("sha256")
        .update(setup.environment.POINTER_PUSH_SECRET)
        .digest("hex"),
      baseUrl: "http://192.168.1.2:7001",
      pushedAt: now,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  );
  await put(
    state,
    "device-names.json",
    JSON.stringify({ "192.168.1.2": "Synthetic TV" }),
  );
  await put(state, "disk-cleanup.json", "[]");
  await put(
    state,
    "torrserver/config/config.db",
    "synthetic database bytes; never opened",
  );
  await put(state, "torrserver/config/settings.json", '{"fixture":true}');
  await put(
    state,
    "run/control.json",
    '{"fixture":"inactive control metadata"}',
  );
  await put(state, "hoshistream.pid", "1\n");
  const environment = {
    STATE: state,
    BACKUP: join(base, "private backup"),
    STAGING: `${state}.restore-staging`,
    HOLD: `${state}.before-restore`,
  };
  return { base, state, entries, original, volumeRoot, volume, environment };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

// Execute the published procedure itself, not a second copy that can drift.
async function procedure(name: "backup" | "restore", data: Fixture) {
  const text = await readFile(guide, "utf8");
  const script = text.match(
    new RegExp("```bash\\n(# hoshistream-" + name + "\\n[\\s\\S]*?)\\n```"),
  )?.[1];
  if (!script) throw new Error(`Missing documented ${name} procedure`);
  return execute("/bin/sh", ["-c", script], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...data.environment },
    timeout: 15_000,
  });
}

async function expectPreserved(data: Fixture) {
  expect(await new Library(join(data.state, "library.json")).list()).toEqual(
    data.entries,
  );
  expect(
    (await new Onboarding(join(data.state, "onboarding.json")).read()).status,
  ).toBe("dismissed");
  expect(await new Tags(join(data.state, "tags.json")).list()).toContain(
    "Drama",
  );
  expect(
    await new ArchiveSchedule(join(data.state, "disk-schedule.json")).window(),
  ).toEqual({ startMinute: 60, endMinute: 120 });
  expect(
    await new VolumeRegistry(
      join(data.state, "volumes.json"),
      join(data.base, "Volumes"),
    ).resolve(data.volume.id),
  ).toEqual({ state: "online", root: data.volumeRoot });
  expect(await readFile(data.original, "utf8")).toBe("synthetic linked bytes");
  expect(
    await readFile(join(data.volumeRoot, "series/episode.mp4"), "utf8"),
  ).toBe("synthetic archived bytes");
  const marker = JSON.parse(
    await readFile(join(data.volumeRoot, MARKER_FILENAME), "utf8"),
  );
  expect(marker.volumeId).toBe(data.volume.id);
  const environment = parseEnvFile(
    await readFile(join(data.state, ".env"), "utf8"),
  );
  const pointer = new PointerClient({
    token: environment.ACCESS_TOKEN,
    pushSecret: environment.POINTER_PUSH_SECRET,
    port: 7001,
    statePath: join(data.state, "pointer-state.json"),
    lanIp: () => "192.168.1.2",
    fetchImpl: () => {
      throw new Error("Recovery must not contact a pointer service");
    },
  });
  expect((await pointer.status()).state).toBe("registered");
}

describe.skipIf(process.platform !== "darwin")(
  "documented macOS data lifecycle",
  () => {
    it("backs up hidden credentials, managed files and auxiliary stores, then restores without merging state", async () => {
      const data = await fixture();
      const envBefore = await readFile(join(data.state, ".env"), "utf8");
      await procedure("backup", data);
      expect((await stat(data.environment.BACKUP)).mode & 0o777).toBe(0o700);
      expect(
        (await stat(join(data.environment.BACKUP, "state/.env"))).mode & 0o777,
      ).toBe(0o600);
      await put(data.state, "library.json", "[]");
      await put(data.state, "newer-state-only.json", '{"preserve":true}');
      await put(data.state, "data/media/upload.mp4", "changed after snapshot");
      await procedure("restore", data);
      await expectPreserved(data);
      expect(
        await readFile(join(data.state, "data/media/upload.mp4"), "utf8"),
      ).toBe("synthetic uploaded bytes");
      expect(
        await readFile(
          join(data.environment.HOLD, "newer-state-only.json"),
          "utf8",
        ),
      ).toBe('{"preserve":true}');
      await expect(
        stat(join(data.state, "newer-state-only.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(data.state, "run"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        stat(join(data.state, "hoshistream.pid")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await stat(`${data.environment.STAGING}.run-records/control.json`);
      await ensureFirstRunSetup({
        projectRoot: data.state,
        pointerStateRoot: data.state,
      });
      expect(
        (await readFile(join(data.state, ".env"), "utf8")) === envBefore,
      ).toBe(true);
      await expect(
        stat(join(data.environment.BACKUP, "COMPLETE")),
      ).resolves.toBeDefined();
    });

    it("refuses a live owner's backup or restore without changing its data", async () => {
      const data = await fixture();
      await procedure("backup", data);
      const owner = await claimRuntimeState(data.state);
      try {
        data.environment.BACKUP = join(data.base, "live backup");
        await expect(procedure("backup", data)).rejects.toThrow();
        await expect(stat(data.environment.BACKUP)).rejects.toMatchObject({
          code: "ENOENT",
        });
        data.environment.BACKUP = join(data.base, "private backup");
        await expect(procedure("restore", data)).rejects.toThrow();
        await expect(stat(data.environment.HOLD)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expectPreserved(data);
      } finally {
        await owner.release();
      }
    });

    it("does not overwrite a backup or restore an incomplete snapshot", async () => {
      const data = await fixture();
      await procedure("backup", data);
      await expect(procedure("backup", data)).rejects.toThrow();
      await rename(
        join(data.environment.BACKUP, "COMPLETE"),
        join(data.environment.BACKUP, "INTERRUPTED"),
      );
      await expect(procedure("restore", data)).rejects.toThrow();
      await expectPreserved(data);
    });

    it("preserves previous recovery attempts rather than merging into a staging or hold directory", async () => {
      const data = await fixture();
      await procedure("backup", data);
      for (const path of [data.environment.STAGING, data.environment.HOLD]) {
        await mkdir(path);
        await expect(procedure("restore", data)).rejects.toThrow();
        await rm(path, { recursive: true });
      }
      await expectPreserved(data);
    });

    it("app-only uninstall and reinstall leave identity, managed data and linked originals intact", async () => {
      const data = await fixture();
      await procedure("backup", data);
      const app = join(data.base, "Applications/HoshiStream.app");
      await put(app, "Contents/fixture", "synthetic app replacement");
      const envBefore = await readFile(join(data.state, ".env"), "utf8");
      await rename(app, join(data.base, "HoshiStream.app-in-Trash"));
      await expectPreserved(data);
      await put(app, "Contents/fixture", "synthetic reinstalled app");
      await ensureFirstRunSetup({
        projectRoot: data.state,
        pointerStateRoot: data.state,
      });
      expect(
        (await readFile(join(data.state, ".env"), "utf8")) === envBefore,
      ).toBe(true);
      await expectPreserved(data);
    });
  },
);

const previousRuntime = process.env.HOSHISTREAM_PREVIOUS_RUNTIME;
const candidateRuntime = process.env.HOSHISTREAM_CANDIDATE_RUNTIME;

it.skipIf(
  process.platform !== "darwin" || !previousRuntime || !candidateRuntime,
)(
  "preserves representative state through the specified packaged readers and a same-path restore",
  async () => {
    if (!previousRuntime || !candidateRuntime)
      throw new Error("Both packaged runtimes are required");
    const data = await fixture();
    const reader = `
      import { readFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const [runtime, state] = process.argv.slice(1);
      const { ensureFirstRunSetup } = await import(pathToFileURL(join(runtime, 'scripts/bootstrap.mjs')));
      const { Library } = await import(pathToFileURL(join(runtime, 'addon/dist/library.js')));
      const before = await readFile(join(state, '.env'), 'utf8');
      await ensureFirstRunSetup({ projectRoot: state, pointerStateRoot: state });
      if (before !== await readFile(join(state, '.env'), 'utf8')) throw new Error('Installation credentials changed');
      const expected = JSON.parse(await readFile(join(state, 'library.json'), 'utf8'));
      const library = new Library(join(state, 'library.json'));
      if (JSON.stringify(await library.list()) !== JSON.stringify(expected)) throw new Error('Packaged reader changed library fields');
      const release = JSON.parse(await readFile(join(runtime, 'addon/release.json'), 'utf8'));
      console.log(JSON.stringify({ buildId: release.buildId, entries: expected.length }));
    `;
    for (const [index, runtime] of [
      previousRuntime,
      candidateRuntime,
    ].entries()) {
      const result = await execute(
        join(runtime, "bin/node"),
        ["--input-type=module", "-e", reader, runtime, data.state],
        {
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          timeout: 15_000,
        },
      );
      expect(JSON.parse(result.stdout)).toEqual({
        buildId: expect.stringMatching(/^\d+\.\d+\.\d+-/),
        entries: data.entries.length,
      });
      if (index === 0) await procedure("backup", data);
    }
    await put(data.state, "library.json", "[]");
    await procedure("restore", data);
    await expectPreserved(data);
    await execute(
      join(previousRuntime, "bin/node"),
      ["--input-type=module", "-e", reader, previousRuntime, data.state],
      {
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        timeout: 15_000,
      },
    );
  },
);
