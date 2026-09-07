import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runNativeSmoke,
  smokeEnvironment,
  smokeOptions,
} from "../../scripts/smoke-native.mjs";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("isolated native smoke", () => {
  it("keeps disposable state in the checkout and preserves source/control modes", () => {
    const options = smokeOptions(["--dev", "--control-stop"]);
    expect(options).toMatchObject({
      packaged: false,
      dev: true,
      controlStop: true,
    });
    expect(options.stateParent).toBe(resolve("../build/native-smoke"));
    expect(
      smokeOptions([
        "--runtime-root=../build/app",
        "--state-parent=../build/evidence",
      ]),
    ).toMatchObject({
      root: resolve("../build/app"),
      stateParent: resolve("../build/evidence"),
      packaged: true,
    });
  });

  it.each([
    ["--runtime-root=app", "--dev"],
    ["--runtime-root="],
    ["--state-parent="],
    ["--state-parent=a", "--state-parent=b"],
    ["--control-stop=false"],
    ["--dev=true"],
    ["--access-token=private"],
  ])("rejects invalid or misleading acceptance options %j", (...args) => {
    expect(() => smokeOptions(args)).toThrow();
  });

  it("does not inherit credentials, injection options, player paths or live user state", () => {
    const state = resolve("../build/smoke-unit-state");
    const environment = smokeEnvironment(state, true, {
      PATH: "/developer/bin",
      ACCESS_TOKEN: "private",
      POINTER_URL: "https://private.invalid",
      NODE_OPTIONS: "--require=untrusted",
      PLAYER_PATH: "/developer/player",
      HOME: "/live/state",
      TMPDIR: "/live/scratch",
    });
    expect(environment).toMatchObject({
      HOME: state,
      USERPROFILE: state,
      TMPDIR: state,
      TEMP: state,
      TMP: state,
    });
    expect(environment.PATH).not.toContain("/developer");
    for (const key of [
      "ACCESS_TOKEN",
      "POINTER_URL",
      "NODE_OPTIONS",
      "PLAYER_PATH",
    ])
      expect(environment).not.toHaveProperty(key);
  });

  it("refuses a packaged run with the wrong Node before creating private state", async () => {
    const parent = resolve("../build/native-smoke-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(`${parent}/candidate-`);
    directories.push(directory);
    await expect(
      runNativeSmoke({
        ...smokeOptions([]),
        root: directory,
        stateParent: directory,
        packaged: true,
      }),
    ).rejects.toThrow(
      "Native smoke failed during candidate validation; child output withheld.",
    );
    await expect(
      runNativeSmoke({
        ...smokeOptions([]),
        root: directory,
        stateParent: parent,
        packaged: true,
      }),
    ).rejects.toThrow(
      "Native smoke failed during candidate validation; child output withheld.",
    );
  });

  it("withholds child logs and errors while preserving unverified failure state", async () => {
    const parent = resolve("../build/native-smoke-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(`${parent}/failure-`);
    directories.push(directory);
    const runtime = join(directory, "runtime");
    const stateParent = join(directory, "state");
    for (const path of ["scripts", "addon/dist", "packaging"])
      await mkdir(join(runtime, path), { recursive: true });
    await writeFile(
      join(runtime, "addon/dist/release.js"),
      'export const releaseInfo = { buildId: "source" };',
    );
    await writeFile(
      join(runtime, "scripts/private-files.mjs"),
      "export async function restrictAccess() {}",
    );
    await writeFile(
      join(runtime, "scripts/native-runtime.mjs"),
      'export async function waitForRuntime() { throw new Error("ACCESS_TOKEN=fake-private-error"); }',
    );
    await writeFile(
      join(runtime, "scripts/native-server.mjs"),
      'console.error("Authorization: Bearer fake-private-log magnet:?xt=fake"); process.exitCode = 1;',
    );
    await writeFile(
      join(runtime, "packaging/torrserver-settings.json"),
      '{"BitTorr":{}}',
    );
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runNativeSmoke({ ...smokeOptions([]), root: runtime, stateParent }),
    ).rejects.toThrow(
      "Native smoke failed during startup; child output withheld.",
    );
    expect(await readdir(stateParent)).toHaveLength(1);
    expect(diagnostics.mock.calls).toEqual([
      [
        "Disposable smoke state preserved under --state-parent; inspect locally before cleanup. No process was force-killed.",
      ],
    ]);
  });
});
