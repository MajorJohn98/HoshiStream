import { createHash, createPublicKey, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  restrictAccess,
  windowsPowerShellEnvironment,
  windowsPowerShellPath,
} from "./private-files.mjs";

export const HOST_NAME = "com.hoshistream.chrome";
export const WINDOWS_REGISTRY_KEY = `Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

// Registry values contain the absolute filename, not literal surrounding quotes.
// No paths are interpolated into PowerShell or passed through cmd.exe.
const registryScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$view = if ($env:HOSHI_REG_VIEW -eq '32') { [Microsoft.Win32.RegistryView]::Registry32 } else { [Microsoft.Win32.RegistryView]::Registry64 }
$root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
$key = $null
try {
  $writable = $env:HOSHI_REG_ACTION -ne 'read'
  $key = $root.OpenSubKey('${WINDOWS_REGISTRY_KEY}', $writable)
  $current = if ($null -eq $key) { $null } else { $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  if ($env:HOSHI_REG_ACTION -eq 'read') {
    ConvertTo-Json -InputObject $current -Compress
  } else {
    $expected = if ($env:HOSHI_REG_EXPECTED_PRESENT -eq 'true') { $env:HOSHI_REG_EXPECTED } else { $null }
    if ($current -cne $expected) { throw 'Registration changed; refusing to overwrite it' }
    if ($env:HOSHI_REG_ACTION -eq 'write') {
      if ($null -eq $key) { $key = $root.CreateSubKey('${WINDOWS_REGISTRY_KEY}') }
      $key.SetValue('', $env:HOSHI_REG_PATH, [Microsoft.Win32.RegistryValueKind]::String)
    } elseif ($env:HOSHI_REG_ACTION -eq 'remove') {
      if ($null -ne $key) { $key.DeleteValue('', $false) }
    } else { throw 'Invalid registry action' }
  }
} finally {
  if ($null -ne $key) { $key.Dispose() }
  $root.Dispose()
}
`;

export function createWindowsRegistry({ run = execFileAsync } = {}) {
  const invoke = async (action, view, path, expected) => {
    if (![32, 64].includes(view)) throw new Error("Invalid registry view");
    try {
      const result = await run(
        windowsPowerShellPath(),
        ["-NoProfile", "-NonInteractive", "-Command", registryScript],
        {
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 64_000,
          env: windowsPowerShellEnvironment({
            HOSHI_REG_ACTION: action,
            HOSHI_REG_VIEW: String(view),
            HOSHI_REG_PATH: path ?? "",
            HOSHI_REG_EXPECTED_PRESENT: String(expected !== null),
            HOSHI_REG_EXPECTED: expected ?? "",
          }),
        },
      );
      if (action !== "read") return;
      const value = JSON.parse(result.stdout.trim());
      if (value !== null && typeof value !== "string")
        throw new Error("Invalid registry value");
      return value;
    } catch {
      throw new Error(
        "Chrome native registration could not access the current-user registry. Check permissions and retry.",
      );
    }
  };
  return {
    read: (view) => invoke("read", view),
    write: (view, path, expected) => invoke("write", view, path, expected),
    remove: (view, expected) => invoke("remove", view, undefined, expected),
  };
}

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
async function atomicWrite(path, contents, mode, secure) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, contents, { mode });
    if (secure) await secure(temporary);
    await rename(temporary, path);
    if (secure) await secure(path);
    else await chmod(path, mode);
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

function locations(options) {
  const platform =
    options.platform ??
    (options.allowTestPlatform ? "darwin" : process.platform);
  if (!["darwin", "win32"].includes(platform))
    throw new Error("The Chrome native bridge supports macOS and Windows");
  const runtimeRoot = resolve(options.runtimeRoot ?? repositoryRoot);
  const projectRoot = resolve(
    options.projectRoot ??
      (platform === "win32"
        ? join(
            process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
            "HoshiStream",
          )
        : join(homedir(), "Library", "Application Support", "HoshiStream")),
  );
  const stateRoot = resolve(options.stateRoot ?? projectRoot);
  const bridgeDirectory = join(stateRoot, "browser-bridge");
  const manifestDirectory = resolve(
    options.manifestDirectory ??
      (platform === "win32"
        ? bridgeDirectory
        : join(
            homedir(),
            "Library",
            "Application Support",
            "Google",
            "Chrome",
            "NativeMessagingHosts",
          )),
  );
  if (platform === "win32" && process.platform === "win32") {
    for (const path of [runtimeRoot, projectRoot, manifestDirectory]) {
      if (
        !/^[a-z]:[\\/]/i.test(path) ||
        /["<>|?*]/.test(path) ||
        [...path].some((character) => character.charCodeAt(0) < 32) ||
        path.slice(2).includes(":")
      )
        throw new Error(
          "Windows Chrome integration requires absolute local-drive paths.",
        );
    }
  }
  return {
    platform,
    runtimeRoot,
    projectRoot,
    bridgeDirectory,
    manifestDirectory,
    configPath: join(
      platform === "win32" ? manifestDirectory : bridgeDirectory,
      "host-config.json",
    ),
    launcherPath:
      platform === "win32"
        ? join(runtimeRoot, "native-host", "HoshiStream.NativeHost.exe")
        : join(bridgeDirectory, "native-host.sh"),
    manifestPath: join(manifestDirectory, HOST_NAME + ".json"),
  };
}

function samePath(a, b, platform) {
  return (
    typeof a === "string" &&
    (platform === "win32"
      ? win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase()
      : a === b)
  );
}

async function ownedManifest(
  manifestPath,
  launcherPath,
  platform,
  { rejectForeign = true } = {},
) {
  try {
    const existing = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      existing?.name !== HOST_NAME ||
      !samePath(existing.path, launcherPath, platform)
    ) {
      if (!rejectForeign) return false;
      throw new Error(
        "Native host registration belongs to another installation",
      );
    }
    return true;
  } catch (error) {
    if (!rejectForeign && error instanceof SyntaxError) return false;
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

export async function registerBrowserBridge(options = {}) {
  const {
    platform,
    runtimeRoot,
    projectRoot,
    bridgeDirectory,
    manifestDirectory,
    configPath,
    launcherPath,
    manifestPath,
  } = locations(options);
  // A macOS test must opt in to a fake registry/ACL adapter; never touch the user's OS.
  if (
    platform === "win32" &&
    process.platform !== "win32" &&
    (!options.registry || !options.restrictAccess)
  )
    throw new Error(
      "Windows registration requires Windows or injected registry and ACL adapters",
    );
  if (
    platform === "win32" &&
    !samePath(projectRoot, dirname(bridgeDirectory), platform)
  )
    throw Object.assign(
      new Error(
        "Windows desktop Chrome integration requires project-root and state-dir to be the same private state directory. Register from the installed desktop app; split source/terminal state cannot be activated by the desktop shell.",
      ),
      { code: "browser_bridge_unavailable" },
    );
  const extension = JSON.parse(
    await readFile(
      join(runtimeRoot, "addon", "assets", "chrome-extension", "manifest.json"),
      "utf8",
    ),
  );
  const extensionId = options.extensionId ?? extensionIdFromKey(extension.key);
  if (
    !/^[a-p]{32}$/.test(extensionId) ||
    extensionId !== extensionIdFromKey(extension.key)
  )
    throw new Error("Invalid Chrome extension ID");
  const bundledNode = join(
    runtimeRoot,
    "bin",
    platform === "win32" ? "node.exe" : "node",
  );
  const vendoredNode = join(
    runtimeRoot,
    "vendor",
    "node",
    `${process.platform}-${process.arch}`,
    "node",
  );
  const node =
    (platform === "win32" ? bundledNode : options.nodePath) ??
    ((await executable(bundledNode))
      ? bundledNode
      : (await executable(vendoredNode))
        ? vendoredNode
        : process.execPath);
  const host = join(runtimeRoot, "addon", "dist", "browser", "host.js");
  if (platform === "win32") {
    for (const path of [
      launcherPath,
      node,
      host,
      join(runtimeRoot, "HoshiStream.exe"),
    ]) {
      try {
        if (!(await stat(path)).isFile())
          throw new Error("Missing runtime file");
      } catch {
        throw Object.assign(
          new Error(
            "Windows Chrome integration is unavailable in this source checkout. Install the Windows desktop build, or publish HoshiStream.NativeHost and HoshiStream.exe into the runtime with bin/node.exe and addon/dist/browser/host.js.",
          ),
          { code: "browser_bridge_unavailable" },
        );
      }
    }
  } else {
    if (!(await executable(node)))
      throw new Error("The bundled Node runtime is unavailable");
    await access(host);
  }
  const registry =
    platform === "win32"
      ? (options.registry ?? createWindowsRegistry({ run: options.run }))
      : undefined;
  const previous = new Map();
  if (registry) {
    for (const view of [32, 64]) {
      const current = await registry.read(view);
      if (current !== null && !samePath(current, manifestPath, platform))
        throw new Error(
          "Chrome native registration belongs to another installation",
        );
      previous.set(view, current);
    }
  }
  await ownedManifest(manifestPath, launcherPath, platform);
  const secure =
    platform === "win32"
      ? (options.restrictAccess ?? restrictAccess)
      : undefined;
  await mkdir(bridgeDirectory, { recursive: true, mode: 0o700 });
  if (secure) await secure(bridgeDirectory, { directory: true });
  await mkdir(manifestDirectory, { recursive: true, mode: 0o700 });
  if (secure) await secure(manifestDirectory, { directory: true });
  const app = resolve(runtimeRoot, "../../..");
  const appPath =
    platform === "win32"
      ? join(runtimeRoot, "HoshiStream.exe")
      : (options.appPath ?? (basename(app).endsWith(".app") ? app : undefined));
  await atomicWrite(
    configPath,
    JSON.stringify(
      {
        version: platform === "win32" ? 2 : 1,
        ...(platform === "win32" ? { platform } : {}),
        extensionId,
        projectRoot,
        ...(appPath ? { appPath: resolve(appPath) } : {}),
      },
      null,
      2,
    ) + "\n",
    0o600,
    secure,
  );
  if (platform === "darwin")
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
    secure,
  );
  if (registry) {
    const changed = [];
    try {
      for (const view of [32, 64]) {
        // HKCU Software keys can be shared between views. Re-read after the
        // first write instead of treating a mirrored value as a competing owner.
        const current = await registry.read(view);
        if (samePath(current, manifestPath, platform)) continue;
        if (current !== previous.get(view))
          throw new Error(
            "Chrome native registration changed during registration",
          );
        await registry.write(view, manifestPath, current);
        changed.push(view);
      }
    } catch (error) {
      for (const view of changed.reverse()) {
        const old = previous.get(view);
        if (old === null) await registry.remove(view, manifestPath);
        else await registry.write(view, old, manifestPath);
      }
      throw error;
    }
  }
  return { extensionId, manifestPath, launcherPath, configPath };
}

export async function unregisterBrowserBridge(options = {}) {
  const { platform, launcherPath, manifestPath } = locations(options);
  if (platform === "win32" && process.platform !== "win32" && !options.registry)
    throw new Error(
      "Windows unregistration requires Windows or an injected registry adapter",
    );
  if (
    !(await ownedManifest(manifestPath, launcherPath, platform, {
      rejectForeign: false,
    }))
  )
    return { removed: false };
  if (platform === "darwin") {
    await unlink(manifestPath);
    return { removed: true };
  }
  const registry =
    options.registry ?? createWindowsRegistry({ run: options.run });
  let removed = false;
  for (const view of [32, 64]) {
    const current = await registry.read(view);
    if (samePath(current, manifestPath, platform)) {
      await registry.remove(view, current);
      removed = true;
    }
  }
  // Retain private files/data; only unregister matching default values, not the key.
  return { removed };
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
  const operation = Object.hasOwn(args, "unregister")
    ? unregisterBrowserBridge
    : registerBrowserBridge;
  operation({
    runtimeRoot: args["runtime-root"] || undefined,
    projectRoot: args["project-root"] || undefined,
    stateRoot: args["state-dir"] || undefined,
    manifestDirectory: args["manifest-dir"] || undefined,
    extensionId: args["extension-id"] || undefined,
  })
    .then(({ extensionId, manifestPath, removed }) => {
      console.log(
        JSON.stringify({
          event:
            operation === registerBrowserBridge
              ? "chrome_bridge_registered"
              : "chrome_bridge_unregistered",
          extensionId,
          manifestPath,
          removed,
        }),
      );
    })
    .catch((error) => {
      console.error(
        error.code === "browser_bridge_unavailable"
          ? error.message
          : "Chrome bridge registration failed. Build the app and check the selected paths and permissions.",
      );
      process.exitCode = 1;
    });
}
