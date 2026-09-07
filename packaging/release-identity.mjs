import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  packageVersion,
  parseReleaseInfo,
  readReleaseInfo,
} from "../addon/src/release.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directoryURL = (directory) => pathToFileURL(resolve(directory) + sep);

export function sourceIdentity(directory = root, git = execFileSync) {
  const options = {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  };
  // Include untracked source files, but never inspect their contents or .env.
  const revision = git(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    options,
  ).trim();
  const dirty =
    git(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      options,
    ).trim() !== "";
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
    throw new Error("Packaging requires a verifiable source revision");
  return { revision, dirty };
}

export function createReleaseIdentity({
  version = packageVersion(directoryURL(join(root, "addon"))),
  source = sourceIdentity(),
  now = new Date(),
  nonce = randomBytes(4).toString("hex"),
} = {}) {
  const builtAt = now.toISOString();
  // Encode Unix minutes as a numeric Apple build version (four/two/two
  // digits). The full timestamp and nonce distinguish builds within a minute.
  const minutes = Math.floor(now.getTime() / 60_000);
  const buildNumber = `${Math.floor(minutes / 10_000)}.${Math.floor(minutes / 100) % 100}.${minutes % 100}`;
  return parseReleaseInfo(
    {
      version,
      ...source,
      builtAt,
      buildNumber,
      buildId: `${version}-${source.revision.slice(0, 12)}${source.dirty ? "-dirty" : ""}-${builtAt.replace(/\D/g, "")}-${nonce}`,
    },
    version,
  );
}

export function writeReleaseIdentity(file, identity) {
  const validated = parseReleaseInfo(identity, identity.version);
  writeFileSync(file, JSON.stringify(validated, null, 2) + "\n");
}

export function verifyMacApp(app, plist = execFileSync) {
  const addon = join(app, "Contents/Resources/runtime/addon");
  const identity = readReleaseInfo(directoryURL(addon));
  if (identity.buildId === "source")
    throw new Error("App has no stamped release identity; rebuild it first");
  for (const [key, value] of Object.entries({
    CFBundleShortVersionString: identity.version,
    CFBundleVersion: identity.buildNumber,
    HoshiStreamBuildID: identity.buildId,
    HoshiStreamRevision: identity.revision,
    HoshiStreamDirty: String(identity.dirty),
  })) {
    const actual = plist(
      "/usr/libexec/PlistBuddy",
      ["-c", `Print :${key}`, join(app, "Contents/Info.plist")],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (actual !== value)
      throw new Error(`App release identity mismatch: ${key}`);
  }
  return identity;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [command, file, field] = process.argv.slice(2);
  if (command === "create" && file) {
    writeReleaseIdentity(file, createReleaseIdentity());
  } else if (command === "field" && file && field) {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const identity = parseReleaseInfo(raw, raw.version);
    if (!Object.hasOwn(identity, field))
      throw new Error("Unknown release identity field");
    process.stdout.write(String(identity[field]));
  } else if (command === "verify-app" && file) {
    process.stdout.write(verifyMacApp(file).buildId);
  } else {
    throw new Error(
      "Usage: release-identity.mjs create <file> | field <file> <field> | verify-app <app>",
    );
  }
}
