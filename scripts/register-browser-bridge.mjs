import { createHash, createPublicKey, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HOST_NAME = "com.hoshistream.chrome";
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function extensionIdFromKey(key) {
  if (typeof key !== "string" || !key.length)
    throw new Error("Chrome extension manifest has no public key");
  const bytes = Buffer.from(key, "base64");
  if (bytes.length > 4096 || bytes.toString("base64") !== key)
    throw new Error("Invalid extension public key");
  createPublicKey({ key: bytes, format: "der", type: "spki" });
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return [...digest]
    .map((character) => String.fromCharCode(97 + parseInt(character, 16)))
    .join("");
}

const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
async function atomicWrite(path, contents, mode) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, contents, { mode });
    await rename(temporary, path);
    await chmod(path, mode);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT")
        console.error('{"event":"chrome_bridge_temp_cleanup_failed"}');
    });
  }
}
async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function registerBrowserBridge(options) {
  if (process.platform !== "darwin" && !options.allowTestPlatform)
    throw new Error("The Chrome native bridge currently supports macOS");
  const runtimeRoot = resolve(options.runtimeRoot ?? repositoryRoot);
  const projectRoot = resolve(
    options.projectRoot ??
      join(homedir(), "Library", "Application Support", "HoshiStream"),
  );
  const stateRoot = resolve(options.stateRoot ?? projectRoot);
  const manifestDirectory = resolve(
    options.manifestDirectory ??
      join(
        homedir(),
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "NativeMessagingHosts",
      ),
  );
  const extension = JSON.parse(
    await readFile(
      join(runtimeRoot, "addon", "assets", "chrome-extension", "manifest.json"),
      "utf8",
    ),
  );
  const extensionId = options.extensionId ?? extensionIdFromKey(extension.key);
  if (!/^[a-p]{32}$/.test(extensionId))
    throw new Error("Invalid Chrome extension ID");
  const bundledNode = join(runtimeRoot, "bin", "node");
  const vendoredNode = join(
    runtimeRoot,
    "vendor",
    "node",
    `${process.platform}-${process.arch}`,
    "node",
  );
  const node =
    options.nodePath ??
    ((await executable(bundledNode))
      ? bundledNode
      : (await executable(vendoredNode))
        ? vendoredNode
        : process.execPath);
  if (!(await executable(node)))
    throw new Error("The bundled Node runtime is unavailable");
  const host = join(runtimeRoot, "addon", "dist", "browser", "host.js");
  await access(host);
  const bridgeDirectory = join(stateRoot, "browser-bridge");
  await mkdir(bridgeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(manifestDirectory, { recursive: true, mode: 0o700 });
  const app = resolve(runtimeRoot, "../../..");
  const appPath =
    options.appPath ?? (basename(app).endsWith(".app") ? app : undefined);
  const configPath = join(bridgeDirectory, "host-config.json");
  const launcherPath = join(bridgeDirectory, "native-host.sh");
  const manifestPath = join(manifestDirectory, HOST_NAME + ".json");
  try {
    const existing = JSON.parse(await readFile(manifestPath, "utf8"));
    if (existing.name !== HOST_NAME)
      throw new Error("Native host registration is not owned by HoshiStream");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWrite(
    configPath,
    JSON.stringify(
      {
        version: 1,
        extensionId,
        projectRoot,
        ...(appPath ? { appPath: resolve(appPath) } : {}),
      },
      null,
      2,
    ) + "\n",
    0o600,
  );
  await atomicWrite(
    launcherPath,
    `#!/bin/sh\nexec ${shellQuote(resolve(node))} ${shellQuote(host)} ${shellQuote(configPath)} "$@"\n`,
    0o700,
  );
  await atomicWrite(
    manifestPath,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: "HoshiStream Chrome companion",
        path: launcherPath,
        type: "stdio",
        allowed_origins: [`chrome-extension://${extensionId}/`],
      },
      null,
      2,
    ) + "\n",
    0o600,
  );
  return { extensionId, manifestPath, launcherPath, configPath };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((argument) => {
      const [key, ...value] = argument.replace(/^--/, "").split("=");
      return [key, value.join("=")];
    }),
  );
  registerBrowserBridge({
    runtimeRoot: args["runtime-root"] || undefined,
    projectRoot: args["project-root"] || undefined,
    stateRoot: args["state-dir"] || undefined,
    manifestDirectory: args["manifest-dir"] || undefined,
    extensionId: args["extension-id"] || undefined,
  })
    .then(({ extensionId, manifestPath }) => {
      console.log(
        JSON.stringify({
          event: "chrome_bridge_registered",
          extensionId,
          manifestPath,
        }),
      );
    })
    .catch(() => {
      console.error(
        "Chrome bridge registration failed. Build the app and check the selected paths and permissions.",
      );
      process.exitCode = 1;
    });
}
