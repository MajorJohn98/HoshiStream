import { describe, expect, it } from "vitest";

globalThis.location = {
  pathname: "/manage/fixture-token",
} as Location;

const { runwaySummary } = await import("../assets/manage/views/devices.js");

describe("runwaySummary", () => {
  it("renders nothing without a sample", () => {
    expect(runwaySummary(undefined)).toBeNull();
    expect(runwaySummary(null)).toBeNull();
  });

  it("marks a healthy runway ok and shows swarm vs bitrate with peers", () => {
    expect(
      runwaySummary({
        readers: 1,
        runwaySeconds: 42.4,
        downloadMbps: 14.25,
        bitrateMbps: 9.1,
        sustainable: true,
        activePeers: 12,
      }),
    ).toEqual({
      tone: "ok",
      label: "Runway 42 s",
      detail: "14.3 Mbps swarm vs 9.1 Mbps needed · 12 peers",
    });
  });

  it("warns when the runway is short or the swarm cannot sustain the bitrate", () => {
    expect(
      runwaySummary({
        readers: 1,
        runwaySeconds: 3,
        downloadMbps: 20,
        bitrateMbps: 9,
        sustainable: true,
        activePeers: 2,
      }).tone,
    ).toBe("warn");
    expect(
      runwaySummary({
        readers: 1,
        runwaySeconds: 90,
        downloadMbps: 5,
        bitrateMbps: 9,
        sustainable: false,
        activePeers: 2,
      }).tone,
    ).toBe("warn");
  });

  it("is neutral without a reader or a known bitrate", () => {
    expect(
      runwaySummary({
        readers: 0,
        runwaySeconds: 0,
        downloadMbps: 0,
        bitrateMbps: 9,
        sustainable: false,
        activePeers: 0,
      }),
    ).toMatchObject({ tone: "idle", label: "No reader attached" });
    expect(
      runwaySummary({
        readers: 1,
        runwaySeconds: null,
        downloadMbps: 7.5,
        bitrateMbps: null,
        sustainable: null,
        activePeers: 3,
      }),
    ).toEqual({
      tone: "idle",
      label: "Runway unknown",
      detail: "7.5 Mbps swarm · bitrate not analyzed",
    });
    expect(
      runwaySummary(
        {
          readers: 1,
          runwaySeconds: null,
          downloadMbps: 7.5,
          bitrateMbps: null,
          sustainable: null,
          activePeers: 3,
        },
        true,
      ).detail,
    ).toBe("7.5 Mbps swarm · measuring bitrate…");
  });
});
