import { describe, expect, it } from "vitest";
import {
  noStoreProtocolResource,
  technicalProbeRequested,
} from "../src/routes.js";

describe("inspection route", () => {
  it("runs the slow technical probe only when explicitly requested", () => {
    expect(technicalProbeRequested(new URL("http://localhost/inspect"))).toBe(
      false,
    );
    expect(
      technicalProbeRequested(new URL("http://localhost/inspect?probe=true")),
    ).toBe(true);
  });

  it("prevents clients from caching expiring stream URLs", () => {
    expect(noStoreProtocolResource("catalog")).toBe(true);
    expect(noStoreProtocolResource("meta")).toBe(true);
    expect(noStoreProtocolResource("stream")).toBe(true);
  });
});
