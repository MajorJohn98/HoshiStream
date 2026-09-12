import { describe, expect, it } from "vitest";

globalThis.location = {
  pathname: "/manage/fixture-token",
} as Location;

const { driftSummary } = await import("../assets/manage/views/pointer.js");

describe("driftSummary", () => {
  it("renders nothing without an observation", () => {
    expect(driftSummary(undefined)).toBeNull();
  });

  it("names both addresses and offers the push when the remote drifted", () => {
    const summary = driftSummary({
      outcome: "remote-mismatch",
      trigger: "lan-change",
      checkedAt: "2026-09-12T10:00:00.000Z",
      remoteBaseUrl: "http://192.168.1.2:7001",
      localBaseUrl: "http://192.168.1.4:7001",
    });
    expect(summary).toMatchObject({
      tone: "warn",
      label: "Remote pointer is out of date",
      actionable: true,
    });
    expect(summary.detail).toContain(
      "Remote points at 192.168.1.2; this computer is 192.168.1.4",
    );
    expect(summary.detail).toContain("after the LAN address changed");
  });

  it("does not offer a push without a LAN address", () => {
    expect(
      driftSummary({
        outcome: "remote-mismatch",
        trigger: "start",
        checkedAt: "2026-09-12T10:00:00.000Z",
        remoteBaseUrl: "http://192.168.1.2:7001",
      }),
    ).toMatchObject({ actionable: false });
  });

  it("is calm on a match and blunt on a failed check", () => {
    expect(
      driftSummary({
        outcome: "match",
        trigger: "start",
        checkedAt: "2026-09-12T10:00:00.000Z",
        remoteBaseUrl: "http://192.168.1.4:7001",
        localBaseUrl: "http://192.168.1.4:7001",
      }),
    ).toMatchObject({ tone: "ok", actionable: false });
    expect(
      driftSummary({
        outcome: "unreachable",
        trigger: "start",
        checkedAt: "2026-09-12T10:00:00.000Z",
        message: "The pointer service could not be reached.",
      }),
    ).toMatchObject({
      tone: "bad",
      label: "Remote check failed",
      detail: expect.stringContaining("could not be reached"),
      actionable: false,
    });
  });
});
