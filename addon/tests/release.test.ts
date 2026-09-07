import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { manifest } from "../src/manifest.ts";
import {
  packageVersion,
  parseReleaseInfo,
  readReleaseInfo,
  releaseInfo,
} from "../src/release.ts";
import {
  createReleaseIdentity,
  sourceIdentity,
  verifyMacApp,
  writeReleaseIdentity,
} from "../../packaging/release-identity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
mkdirSync(join(root, "build"), { recursive: true });
const fixtures = mkdtempSync(join(root, "build/release-tests-"));
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));
const version = packageVersion(pathToFileURL(join(root, "addon") + sep));
const revision = "231ae20" + "a".repeat(33);
const now = new Date("2026-09-07T15:00:00.000Z");

function identity(dirty = false) {
  return createReleaseIdentity({
    version,
    source: { revision, dirty },
    now,
    nonce: "1234abcd",
  });
}

function addon(directory = mkdtempSync(join(fixtures, "addon-"))) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ version, type: "module" }),
  );
  return { directory, url: pathToFileURL(directory + sep) };
}

describe("release identity", () => {
  it("uses the package version everywhere without calling git at runtime", () => {
    expect(releaseInfo.version).toBe(version);
    expect(manifest.version).toBe(version);
    expect(readReleaseInfo(addon().url)).toEqual({
      version,
      revision: "source",
      dirty: null,
      buildId: "source",
      buildNumber: null,
      builtAt: null,
    });
  });

  it("distinguishes a dirty candidate and individual builds", () => {
    const clean = identity();
    const dirty = identity(true);
    expect(clean.buildId).not.toContain("-dirty-");
    expect(dirty.buildId).toContain("-dirty-");
    expect(dirty.revision).toBe(revision);
    expect(dirty.buildNumber).toMatch(/^\d{1,4}\.\d{1,2}\.\d{1,2}$/);
    expect(
      createReleaseIdentity({
        version,
        source: { revision, dirty: true },
        now,
        nonce: "aaaaaaaa",
      }).buildId,
    ).not.toBe(dirty.buildId);
  });

  it("reads a frozen stamp, with no extra fields exposed", () => {
    const fixture = addon();
    const stamped = identity(true);
    writeReleaseIdentity(join(fixture.directory, "release.json"), stamped);
    expect(readReleaseInfo(fixture.url)).toEqual(stamped);
    expect(Object.isFrozen(readReleaseInfo(fixture.url))).toBe(true);
    expect(
      parseReleaseInfo({ ...stamped, unrelated: "ignored" }, version),
    ).toEqual(stamped);
  });

  it.each([
    { version: "0.0.0" },
    { dirty: null },
    { dirty: "false" },
    { revision: "source" },
    { revision: "a".repeat(41) },
    { buildId: "../candidate" },
    { buildNumber: "1" },
    { buildNumber: "1234.1.1" },
    { builtAt: "not-a-date" },
    { builtAt: "2026-02-30T15:00:00.000Z" },
  ])("fails closed for invalid or stale metadata %j", (change) => {
    const fixture = addon();
    writeFileSync(
      join(fixture.directory, "release.json"),
      JSON.stringify({ ...identity(), ...change }),
    );
    expect(() => readReleaseInfo(fixture.url)).toThrow();
  });

  it("does not disguise corrupt metadata or package versions as source", () => {
    const fixture = addon();
    writeFileSync(join(fixture.directory, "release.json"), "{");
    expect(() => readReleaseInfo(fixture.url)).toThrow();
    writeFileSync(join(fixture.directory, "package.json"), '{"version":42}');
    expect(() => readReleaseInfo(fixture.url)).toThrow(
      "Invalid release package version",
    );
  });

  it("captures actual revision and all untracked source dirtiness once", () => {
    const git = vi
      .fn()
      .mockReturnValueOnce(`${revision}\n`)
      .mockReturnValueOnce("?? addon/src/new.ts\n");
    expect(sourceIdentity(root, git)).toEqual({ revision, dirty: true });
    expect(git).toHaveBeenNthCalledWith(
      2,
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      expect.objectContaining({
        cwd: root,
        env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: "0" }),
      }),
    );
    expect(
      sourceIdentity(
        root,
        vi.fn().mockReturnValueOnce(revision).mockReturnValueOnce(""),
      ),
    ).toEqual({ revision, dirty: false });
    expect(() =>
      sourceIdentity(root, () => {
        throw new Error("git unavailable");
      }),
    ).toThrow("git unavailable");
  });

  it("runs source and compiled dist from the packaged location and another cwd", () => {
    const fixture = addon();
    const src = join(fixture.directory, "src");
    mkdirSync(src);
    for (const file of ["release.ts", "manifest.ts"])
      cpSync(join(root, "addon/src", file), join(src, file));
    execFileSync(
      process.execPath,
      [
        join(root, "addon/node_modules/typescript/bin/tsc"),
        "--target",
        "ES2024",
        "--module",
        "NodeNext",
        "--strict",
        "--skipLibCheck",
        "--rewriteRelativeImportExtensions",
        "--outDir",
        join(fixture.directory, "dist"),
        "src/release.ts",
        "src/manifest.ts",
      ],
      { cwd: join(root, "addon"), stdio: "pipe" },
    );
    for (const stamp of [false, true]) {
      if (stamp)
        writeReleaseIdentity(
          join(fixture.directory, "release.json"),
          identity(true),
        );
      for (const [folder, extension] of [
        ["src", "ts"],
        ["dist", "js"],
      ]) {
        const module = pathToFileURL(
          join(fixture.directory, folder, `release.${extension}`),
        ).href;
        const manifestModule = pathToFileURL(
          join(fixture.directory, folder, `manifest.${extension}`),
        ).href;
        const output = execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { releaseInfo } from ${JSON.stringify(module)}; import { manifest } from ${JSON.stringify(manifestModule)}; console.log(JSON.stringify({ releaseInfo, version: manifest.version }));`,
          ],
          { cwd: fixtures, encoding: "utf8" },
        );
        const result = JSON.parse(output);
        expect(result.version).toBe(version);
        expect(result.releaseInfo).toEqual(
          stamp
            ? identity(true)
            : expect.objectContaining({ buildId: "source", dirty: null }),
        );
      }
    }
  });
});

describe("macOS candidate packaging", () => {
  it.skipIf(process.platform !== "darwin")(
    "verifies a real plist and metadata with the packaging CLI without building the app",
    () => {
      const app = join(fixtures, "CLI-check.app");
      const fixture = addon(join(app, "Contents/Resources/runtime/addon"));
      const metadata = join(fixture.directory, "release.json");
      const cli = join(root, "packaging/release-identity.mjs");
      execFileSync(process.execPath, [cli, "create", metadata], {
        cwd: fixtures,
      });
      const stamp = readReleaseInfo(fixture.url);
      const plist = join(app, "Contents/Info.plist");
      cpSync(join(root, "supervisor/macos/Info.plist"), plist);
      for (const [key, value] of Object.entries({
        CFBundleShortVersionString: stamp.version,
        CFBundleVersion: stamp.buildNumber,
        HoshiStreamBuildID: stamp.buildId,
        HoshiStreamRevision: stamp.revision,
        HoshiStreamDirty: stamp.dirty,
      }))
        execFileSync("/usr/libexec/PlistBuddy", [
          "-c",
          `Set :${key} ${value}`,
          plist,
        ]);
      expect(
        execFileSync(process.execPath, [cli, "verify-app", app], {
          cwd: fixtures,
          encoding: "utf8",
        }),
      ).toBe(stamp.buildId);
      expect(
        execFileSync(process.execPath, [cli, "field", metadata, "version"], {
          encoding: "utf8",
        }),
      ).toBe(version);
    },
  );

  it("reuses the bundled stamp, and rejects missing or mismatched plist fields", () => {
    const app = join(fixtures, "HoshiStream.app");
    const fixture = addon(join(app, "Contents/Resources/runtime/addon"));
    expect(() => verifyMacApp(app, vi.fn())).toThrow("no stamped");
    const stamp = identity(true);
    writeReleaseIdentity(join(fixture.directory, "release.json"), stamp);
    const values: Record<string, string> = {
      CFBundleShortVersionString: stamp.version,
      CFBundleVersion: stamp.buildNumber,
      HoshiStreamBuildID: stamp.buildId,
      HoshiStreamRevision: stamp.revision,
      HoshiStreamDirty: "true",
    };
    const plist = (_command: string, args: string[]) =>
      values[args[1].replace("Print :", "")] + "\n";
    expect(verifyMacApp(app, plist)).toEqual(stamp);
    values.HoshiStreamBuildID = "wrong-build";
    expect(() => verifyMacApp(app, plist)).toThrow(
      "identity mismatch: HoshiStreamBuildID",
    );
  });

  it("stamps once in app packaging and names the DMG from the verified app", () => {
    const app = readFileSync(
      join(root, "packaging/build-macos-app.sh"),
      "utf8",
    );
    const dmg = readFileSync(
      join(root, "packaging/build-macos-dmg.sh"),
      "utf8",
    );
    expect(app.match(/release-identity\.mjs" create/g)).toHaveLength(1);
    expect(app).toContain('cp "$IDENTITY" "$RUNTIME/addon/release.json"');
    expect(dmg).toContain('release-identity.mjs" verify-app "$APP"');
    expect(dmg).not.toContain('release-identity.mjs" create');
    expect(dmg).toContain('ARTIFACT="HoshiStream-$BUILD_ID-darwin-arm64"');
    expect(dmg).toContain('"$BUILD_DIR/$ARTIFACT.release.json"');
  });
});
