import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore cross-platform native packaging script
import {
  extensionIdFromKey,
  registerBrowserBridge,
} from "../../scripts/register-browser-bridge.mjs";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true });
});

describe("Chrome native registration", () => {
  it("registers a private, token-free helper using the manifest's stable identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoshi-registration-"));
    directories.push(root);
    const runtimeRoot = join(root, "Hoshi Stream's runtime");
    const stateRoot = join(root, "state");
    const manifestDirectory = join(root, "chrome", "NativeMessagingHosts");
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
    const extensionDir = join(
      runtimeRoot,
      "addon",
      "assets",
      "chrome-extension",
    );
    await mkdir(extensionDir, { recursive: true });
    await mkdir(join(runtimeRoot, "addon", "dist", "browser"), {
      recursive: true,
    });
    await mkdir(join(runtimeRoot, "bin"), { recursive: true });
    await writeFile(
      join(extensionDir, "manifest.json"),
      JSON.stringify({ key }),
    );
    await writeFile(
      join(runtimeRoot, "addon", "dist", "browser", "host.js"),
      "",
    );
    const node = join(runtimeRoot, "bin", "node");
    await writeFile(node, "#!/bin/sh\nexit 0\n");
    await chmod(node, 0o700);
    const result = await registerBrowserBridge({
      runtimeRoot,
      projectRoot: stateRoot,
      stateRoot,
      manifestDirectory,
      allowTestPlatform: true,
    });
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(manifest.allowed_origins).toEqual([
      `chrome-extension://${extensionIdFromKey(key)}/`,
    ]);
    expect(manifest.allowed_origins.join()).not.toContain("*");
    expect(manifest.path).toBe(result.launcherPath);
    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config).toEqual({
      version: 1,
      extensionId: result.extensionId,
      projectRoot: stateRoot,
    });
    expect(JSON.stringify(config)).not.toContain("ACCESS_TOKEN");
    expect(await readFile(result.launcherPath, "utf8")).toContain("'\\''");
    if (process.platform !== "win32") {
      expect((await stat(result.configPath)).mode & 0o777).toBe(0o600);
      expect((await stat(result.launcherPath)).mode & 0o777).toBe(0o700);
    }
    expect(
      (
        await registerBrowserBridge({
          runtimeRoot,
          projectRoot: stateRoot,
          stateRoot,
          manifestDirectory,
          allowTestPlatform: true,
        })
      ).extensionId,
    ).toBe(result.extensionId);
  });

  it("does not accept malformed extension public keys", () => {
    expect(() => extensionIdFromKey("not-a-public-key")).toThrow();
  });
});
