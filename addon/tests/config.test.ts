import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config-schema.js";

const valid = {
  TORRSERVER_INTERNAL_URL: "http://torrserver:8090",
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
      LIBRARY_PATH: "/data/library.json",
      LOG_LEVEL: "info",
    });
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
