import { readFileSync } from "node:fs";

export interface ReleaseInfo {
  readonly version: string;
  readonly revision: string;
  readonly dirty: boolean | null;
  readonly buildId: string;
  readonly buildNumber: string | null;
  readonly builtAt: string | null;
}

export function packageVersion(addonRoot: URL): string {
  const value: unknown = JSON.parse(
    readFileSync(new URL("package.json", addonRoot), "utf8"),
  );
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.version)
  )
    throw new Error("Invalid release package version");
  return value.version;
}

export function parseReleaseInfo(value: unknown, version: string): ReleaseInfo {
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !value ||
    typeof value !== "object"
  )
    throw new Error("Invalid release metadata");
  const info = value as Record<string, unknown>;
  if (
    info.version !== version ||
    typeof info.revision !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(info.revision) ||
    typeof info.dirty !== "boolean" ||
    typeof info.builtAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(info.builtAt) ||
    !Number.isFinite(Date.parse(info.builtAt)) ||
    typeof info.buildNumber !== "string" ||
    !/^[1-9]\d{0,3}\.\d{1,2}\.\d{1,2}$/.test(info.buildNumber) ||
    typeof info.buildId !== "string"
  )
    throw new Error("Invalid or mismatched release metadata");
  const minutes = Math.floor(Date.parse(info.builtAt) / 60_000);
  const buildNumber = `${Math.floor(minutes / 10_000)}.${Math.floor(minutes / 100) % 100}.${minutes % 100}`;
  if (
    new Date(info.builtAt).toISOString() !== info.builtAt ||
    info.buildNumber !== buildNumber
  )
    throw new Error("Inconsistent release build date or number");
  const prefix = `${version}-${info.revision.slice(0, 12)}${info.dirty ? "-dirty" : ""}-${info.builtAt.replace(/\D/g, "")}-`;
  if (
    !info.buildId.startsWith(prefix) ||
    !/^[a-f0-9]{8}$/.test(info.buildId.slice(prefix.length))
  )
    throw new Error("Invalid release build identity");
  return Object.freeze({
    version,
    revision: info.revision,
    dirty: info.dirty,
    buildId: info.buildId,
    buildNumber: info.buildNumber,
    builtAt: info.builtAt,
  });
}

export function readReleaseInfo(
  addonRoot = new URL("../", import.meta.url),
): ReleaseInfo {
  const version = packageVersion(addonRoot);
  let text: string;
  try {
    text = readFileSync(new URL("release.json", addonRoot), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A checkout (including plain tsc output) is not a stamped candidate.
    // Do not infer a clean revision, acceptance, or build date at runtime.
    return Object.freeze({
      version,
      revision: "source",
      dirty: null,
      buildId: "source",
      buildNumber: null,
      builtAt: null,
    });
  }
  return parseReleaseInfo(JSON.parse(text), version);
}

export const releaseInfo = readReleaseInfo();
