import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MagnetLinks } from "../src/imports/magnet-links.ts";
import {
  MAGNET_LINK_ROUTE,
  magnetLinkPrefill,
  magnetLinkRouteId,
} from "../assets/manage/magnet-link.js";

const magnet = `magnet:?xt=urn:btih:${"a".repeat(40)}&dn=An%20authorized%20film&tr=udp%3A%2F%2Ftracker.example%3A80`;

describe("native magnet handoff tickets", () => {
  it("returns an opaque reference and preserves the complete source only in the authenticated read", () => {
    const links = new MagnetLinks(() => 1_000);
    const ticket = links.issue(magnet);
    expect(ticket).toEqual({
      id: expect.any(String),
      expiresAt: new Date(601_000).toISOString(),
    });
    expect(JSON.stringify(ticket)).not.toContain("magnet:");
    expect(links.read(ticket.id)).toEqual({
      ...ticket,
      magnetUri: magnet,
      suggestedName: "An authorized film",
    });
    expect(links.issue(magnet)).toEqual(ticket);
  });

  it("expires links and clears them on shutdown", () => {
    let now = 0;
    const links = new MagnetLinks(() => now);
    const ticket = links.issue(magnet);
    now = 600_000;
    expect(() => links.read(ticket.id)).toThrow("expired");
    const next = links.issue(magnet);
    expect(next.id).not.toBe(ticket.id);
    links.clear();
    expect(() => links.read(next.id)).toThrow("expired");
  });

  it("bounds pending links and rejects malformed or ambiguous magnets", () => {
    const links = new MagnetLinks();
    for (let index = 0; index < 32; index++)
      links.issue(`${magnet}&source=${index}`);
    expect(() => links.issue(`${magnet}&source=overflow`)).toThrow("Too many");
    expect(() => links.issue("https://example.com/file.torrent")).toThrow(
      "valid",
    );
    expect(() =>
      links.issue(`${magnet}&xt=urn:btih:${"b".repeat(40)}`),
    ).toThrow("exactly one");
    expect(() => links.issue("magnet:?" + "a".repeat(16_384))).toThrow("valid");
  });
});

describe("magnet review route and input", () => {
  it("accepts only opaque ticket routes, not raw magnets or arbitrary paths", () => {
    const id = randomUUID();
    expect(magnetLinkRouteId(MAGNET_LINK_ROUTE + id)).toBe(id);
    expect(magnetLinkRouteId("#/library")).toBeNull();
    expect(magnetLinkRouteId("#/add")).toBeNull();
    for (const value of [magnet, `${id}/extra`, "%2e%2e", ""])
      expect(() => magnetLinkRouteId(MAGNET_LINK_ROUTE + value)).toThrow(
        "invalid",
      );
  });

  it("checks the response identity and expiry before prefilling editable fields", () => {
    const links = new MagnetLinks();
    const ticket = links.issue(magnet);
    const input = links.read(ticket.id);
    expect(magnetLinkPrefill(input, ticket.id)).toEqual({
      name: "An authorized film",
      magnetUri: magnet,
    });
    expect(() => magnetLinkPrefill(input, randomUUID())).toThrow(
      "could not be read",
    );
    expect(() =>
      magnetLinkPrefill({ ...input, magnetUri: undefined }, ticket.id),
    ).toThrow("could not be read");
    expect(() =>
      magnetLinkPrefill(input, ticket.id, Date.parse(input.expiresAt)),
    ).toThrow("expired");
  });
});
