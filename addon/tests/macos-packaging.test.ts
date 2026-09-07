import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  verifyAssetReceipt,
  writeAssetReceipt,
} from "../../packaging/asset-receipt.mjs";
import {
  assertPortableMachO,
  macRuntimeScripts,
  requiredMacRuntimeFiles,
  validateMacPayload,
  validateMacRedistribution,
  verifyMacInventory,
  verifyMacVendor,
} from "../../packaging/macos-contract.mjs";
import { sha256 } from "../../packaging/windows-build-tools.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "hoshi-macos-packaging-"));
  temporary.push(path);
  return path;
}
async function put(root: string, file: string, text = "fixture") {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
}
async function payload() {
  const app = await directory();
  const runtime = join(app, "Contents/Resources/runtime");
  for (const file of requiredMacRuntimeFiles) await put(runtime, file);
  return { app, runtime };
}

describe("macOS runtime provenance", () => {
  it("requires a verified-download receipt, not an installed developer tool", async () => {
    const path = await directory();
    await expect(
      verifyAssetReceipt(path, { node: "pin" }, ["node"]),
    ).rejects.toThrow("Missing runtime provenance");
    await put(path, "node");
    await writeAssetReceipt(path, { node: "pin" }, ["node"]);
    await expect(
      verifyAssetReceipt(path, { node: "pin" }, ["node"]),
    ).resolves.toBeUndefined();
    await expect(
      verifyAssetReceipt(path, { node: "new-pin" }, ["node"]),
    ).rejects.toThrow("Stale runtime provenance");
    await put(path, "node", "changed");
    await expect(
      verifyAssetReceipt(path, { node: "pin" }, ["node"]),
    ).rejects.toThrow("checksum mismatch");
  });

  it("binds Node notices, both FFmpeg tools and TorrServer to their pins", async () => {
    const path = await directory();
    await put(
      path,
      "packaging/node-lock.json",
      JSON.stringify({
        "darwin-arm64": { sha256: "node-archive" },
      }),
    );
    await put(
      path,
      "packaging/ffmpeg-lock.json",
      JSON.stringify({
        "darwin-arm64": {
          ffmpeg: { sha256: "ffmpeg-archive" },
          ffprobe: { sha256: "ffprobe-archive" },
        },
      }),
    );
    await put(
      path,
      "packaging/torrserver-lock.json",
      JSON.stringify({
        "darwin-arm64": { sha256: sha256(Buffer.from("fixture")) },
      }),
    );
    await put(path, "vendor/torrserver/darwin-arm64/TorrServer");
    const node = join(path, "vendor/node/darwin-arm64");
    await put(node, "node");
    await put(node, "LICENSE");
    await writeAssetReceipt(node, { node: "node-archive" }, [
      "node",
      "LICENSE",
    ]);
    const ffmpeg = join(path, "vendor/ffmpeg/darwin-arm64");
    await put(ffmpeg, "ffmpeg");
    await put(ffmpeg, "ffprobe");
    await writeAssetReceipt(
      ffmpeg,
      {
        ffmpeg: "ffmpeg-archive",
        ffprobe: "ffprobe-archive",
      },
      ["ffmpeg", "ffprobe"],
    );
    await expect(verifyMacVendor(path)).resolves.toBeUndefined();
    await put(path, "vendor/torrserver/darwin-arm64/TorrServer", "unverified");
    await expect(verifyMacVendor(path)).rejects.toThrow(
      "TorrServer checksum mismatch",
    );
  });
});

describe("macOS portable payload", () => {
  it("requires browser assets, notices and every server/analysis runtime, but not mpv", async () => {
    const { app, runtime } = await payload();
    expect(await validateMacPayload(app)).toContain(
      "Contents/Resources/runtime/vendor/ffmpeg/darwin-arm64/ffprobe",
    );
    expect(requiredMacRuntimeFiles.some((file) => file.includes("/mpv"))).toBe(
      false,
    );
    await rm(join(runtime, "vendor/ffmpeg/darwin-arm64/ffprobe"));
    await expect(validateMacPayload(app)).rejects.toThrow();
  });

  it.each([
    ".env",
    "addon/.env.local",
    "native-data/library.json",
    "logs/server.log",
    "data/media/private.mp4",
    "addon/src/index.ts",
    "addon/assets/library.json",
    "scripts/.git/config",
    "addon/node_modules/typescript/package.json",
  ])("rejects private or developer file %s", async (file) => {
    const { app, runtime } = await payload();
    await put(runtime, file);
    await expect(validateMacPayload(app)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlinks outside the portable payload",
    async () => {
      const { app, runtime } = await payload();
      await symlink("/tmp", join(runtime, "outside"));
      await expect(validateMacPayload(app)).rejects.toThrow("Unsupported link");
    },
  );

  it("includes the runtime's complete relative import closure", async () => {
    const build = await readFile(
      join(root, "packaging/build-macos-app.sh"),
      "utf8",
    );
    for (const script of macRuntimeScripts) {
      expect(build).toContain(`$ROOT/scripts/${script}`);
      const text = await readFile(join(root, "scripts", script), "utf8");
      for (const match of text.matchAll(
        /(?:from\s+|import\s*)["']\.\/([^"']+\.mjs)["']/g,
      ))
        expect(macRuntimeScripts, `${script} imports ${match[1]}`).toContain(
          match[1],
        );
    }
    expect(build.indexOf('macos-contract.mjs" vendor')).toBeLessThan(
      build.indexOf('rm -rf "$APP"'),
    );
    expect(build).not.toContain("repair then uses PATH");
    expect(build.indexOf('codesign --force --sign - "$APP"')).toBeLessThan(
      build.indexOf('macos-contract.mjs" stamp "$APP"'),
    );
  });

  it("rejects changed bytes and inventory drift after signing", async () => {
    const { app, runtime } = await payload();
    const files: Record<string, string> = {};
    for (const file of await validateMacPayload(app))
      files[file] = sha256(await readFile(join(app, file)));
    await writeFile(
      `${app}.payload.json`,
      JSON.stringify({
        version: 1,
        buildId: "fixture-build",
        files,
      }),
    );
    temporary.push(`${app}.payload.json`);
    await expect(
      verifyMacInventory(app, "fixture-build"),
    ).resolves.toBeUndefined();
    await expect(verifyMacInventory(app, "different-build")).rejects.toThrow(
      "stale",
    );
    await put(runtime, "addon/assets/manage/app.js", "changed after signing");
    await expect(verifyMacInventory(app, "fixture-build")).rejects.toThrow(
      "checksum mismatch",
    );
    await put(runtime, "addon/assets/manage/app.js");
    await put(runtime, "addon/assets/unexpected.js");
    await expect(verifyMacInventory(app, "fixture-build")).rejects.toThrow(
      "unexpected files",
    );
  });

  it("requires only system dylibs and an OS target no higher than 13.5", () => {
    const libs =
      "fixture:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n";
    const commands =
      "cmd LC_BUILD_VERSION\n cmdsize 32\n platform 1\n minos 13.5\n sdk 15.5\n";
    expect(() => assertPortableMachO(libs, commands)).not.toThrow();
    expect(() =>
      assertPortableMachO(
        libs,
        commands +
          "\ncmd LC_RPATH\ncmdsize 32\npath /usr/lib/swift (offset 12)",
      ),
    ).not.toThrow();
    expect(() =>
      assertPortableMachO(
        libs,
        commands +
          "\ncmd LC_RPATH\ncmdsize 32\npath /opt/homebrew/lib (offset 12)",
      ),
    ).toThrow("search path");
    expect(() =>
      assertPortableMachO(
        libs.replace("/usr/lib/", "/opt/homebrew/lib/"),
        commands,
      ),
    ).toThrow("Non-system");
    expect(() =>
      assertPortableMachO(libs, commands.replace("13.5", "14.0")),
    ).toThrow("newer macOS");
    expect(() =>
      assertPortableMachO(libs, commands + "\ncmd LC_RPATH"),
    ).toThrow("search path");
    expect(() => assertPortableMachO(libs, "no deployment target")).toThrow();
  });
});

describe("macOS redistribution gate", () => {
  it("blocks missing review and does not relax the Windows gate", async () => {
    await expect(
      validateMacRedistribution(await directory(), await directory()),
    ).rejects.toThrow("Release blocked: reviewed vendor/macos-redistribution");
    const dmg = await readFile(
      join(root, "packaging/build-macos-dmg.sh"),
      "utf8",
    );
    expect(dmg).toContain("MODE=release");
    expect(dmg).toContain('macos-contract.mjs" redistribution');
    expect(dmg).toContain('ARTIFACT="$ARTIFACT-LOCAL-ONLY"');
    expect(dmg).toContain('macos-contract.mjs" checksum');
    expect(dmg).not.toContain('rm -rf "$STAGE" "$DMG"');
  });

  it("binds reviewed source and npm notices to the packaged locks, not current checkout pins", async () => {
    const path = await directory();
    const runtime = await directory();
    const components: Record<string, unknown> = {};
    for (const name of ["node", "torrserver", "ffmpeg", "npm"]) {
      const lock =
        name === "npm"
          ? "addon/package-lock.json"
          : `packaging/${name}-lock.json`;
      await put(runtime, lock, name);
      await put(path, `${name}.txt`, `review fixture ${name}`);
      components[name] = {
        pinSha256: sha256(Buffer.from(name)),
        completeCorrespondingSource: true,
        files: [
          {
            path: `${name}.txt`,
            sha256: sha256(Buffer.from(`review fixture ${name}`)),
          },
        ],
      };
    }
    await put(
      path,
      "manifest.json",
      JSON.stringify({
        version: 1,
        reviewedBy: "test fixture only, not an attestation",
        components,
      }),
    );
    await expect(
      validateMacRedistribution(path, runtime),
    ).resolves.toBeUndefined();
    await put(runtime, "addon/package-lock.json", "changed dependencies");
    await expect(validateMacRedistribution(path, runtime)).rejects.toThrow(
      "stale",
    );
    await put(runtime, "addon/package-lock.json", "npm");
    await put(path, "ffmpeg.txt", "tampered");
    await expect(validateMacRedistribution(path, runtime)).rejects.toThrow(
      "checksum mismatch",
    );
  });
});
