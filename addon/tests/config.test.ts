import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  containerHostnameWarning,
  parseConfig,
  stateRoot,
} from "../src/config-schema.ts";

const valid = {
  TORRSERVER_INTERNAL_URL: "http://127.0.0.1:8090",
  PUBLIC_TORRSERVER_URL: "http://192.168.1.50:8090",
  PUBLIC_ADDON_URL: "http://192.168.1.50:7000",
  ACCESS_TOKEN: "a-long-private-token-value",
};

describe("parseConfig", () => {
  it("validates and applies safe defaults", () => {
    expect(parseConfig(valid)).toMatchObject({
      ADDON_PORT: 7000,
      HOME_SPEED_MBPS: 10,
      LAN_REDIRECT: "auto",
      LIBRARY_PATH: join(stateRoot(), "library.json"),
      LOG_LEVEL: "info",
    });
  });

  it("keeps stream repair off by default and parses its settings", () => {
    const defaults = parseConfig(valid);
    expect(defaults.TRANSCODE_ENABLED).toBe(false);
    expect(defaults.TRANSCODE_MAX_SESSIONS).toBe(2);
    expect(defaults.TRANSCODE_VIDEO_BITRATE_MBPS).toBe(8);
    expect(defaults.TRANSCODE_DIR).toBe(join(stateRoot(), "transcode"));
    expect(defaults.FFMPEG_PATH).toBe("ffmpeg");
    expect(
      parseConfig({ ...valid, TRANSCODE_ENABLED: "true" }).TRANSCODE_ENABLED,
    ).toBe(true);
    expect(
      parseConfig({ ...valid, TRANSCODE_ENABLED: "1" }).TRANSCODE_ENABLED,
    ).toBe(true);
    expect(
      parseConfig({ ...valid, TRANSCODE_ENABLED: "no" }).TRANSCODE_ENABLED,
    ).toBe(false);
    expect(() =>
      parseConfig({ ...valid, TRANSCODE_MAX_SESSIONS: "0" }),
    ).toThrow();
  });

  it("accepts disabling LAN redirect and rejects unknown values", () => {
    expect(parseConfig({ ...valid, LAN_REDIRECT: "off" }).LAN_REDIRECT).toBe(
      "off",
    );
    expect(() => parseConfig({ ...valid, LAN_REDIRECT: "on" })).toThrow();
  });

  it("rejects missing or malformed public configuration", () => {
    expect(() =>
      parseConfig({ ...valid, PUBLIC_TORRSERVER_URL: "torrserver:8090" }),
    ).toThrow();
    expect(() => parseConfig({ ...valid, ACCESS_TOKEN: "short" })).toThrow();
  });
});

describe("state root", () => {
  it("uses Application Support on macOS", () => {
    expect(stateRoot("darwin", {})).toBe(
      join(homedir(), "Library", "Application Support", "HoshiStream"),
    );
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(
      stateRoot("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }),
    ).toBe("C:\\Users\\me\\AppData\\Local\\HoshiStream");
  });

  it("falls back to a default when LOCALAPPDATA is unset", () => {
    expect(stateRoot("win32", {})).toBe(
      win32.join(homedir(), "AppData", "Local", "HoshiStream"),
    );
  });
});

// Compose is gone, so an inherited .env pointing at a container hostname would
// otherwise fail late with an opaque connection error.
describe("stale container hostname warning", () => {
  it("flags Compose service hostnames", () => {
    expect(
      containerHostnameWarning(
        "http://torrserver:8090",
        "TORRSERVER_INTERNAL_URL",
      ),
    ).toContain("no longer runs in containers");
    expect(
      containerHostnameWarning("http://addon:7000", "PUBLIC_ADDON_URL"),
    ).toBeDefined();
  });

  it("stays quiet for real hosts", () => {
    expect(
      containerHostnameWarning("http://127.0.0.1:8090", "X"),
    ).toBeUndefined();
    expect(
      containerHostnameWarning("http://192.168.1.50:8090", "X"),
    ).toBeUndefined();
  });

  it("warns during parseConfig instead of failing", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = parseConfig({
      ...valid,
      TORRSERVER_INTERNAL_URL: "http://torrserver:8090",
    });

    expect(config.TORRSERVER_INTERNAL_URL).toBe("http://torrserver:8090");
    expect(logged).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0][0]).toContain("stale_container_hostname");
    logged.mockRestore();
  });
});
