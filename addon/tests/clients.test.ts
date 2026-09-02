import { afterEach, describe, expect, it } from "vitest";
import {
  deviceLabel,
  listClients,
  recordClient,
  resetClients,
} from "../src/clients.js";

afterEach(() => resetClients());

describe("deviceLabel", () => {
  it("labels known clients and players", () => {
    expect(deviceLabel("Nuvio/1.2 (AndroidTV)")).toBe("Nuvio");
    expect(deviceLabel("Stremio/4.4 Shell")).toBe("Stremio");
    expect(deviceLabel("VLC/3.0.20 LibVLC/3.0.20")).toBe("VLC");
    expect(deviceLabel("ExoPlayerLib/2.19")).toBe("ExoPlayer (Android)");
    expect(deviceLabel("Mozilla/5.0 (CrKey armv7l)")).toBe("Chromecast");
    expect(deviceLabel("")).toBe("Unknown device");
    expect(deviceLabel("SomethingNew/9")).toBe("Unknown device");
  });
});

describe("recordClient / listClients", () => {
  it("aggregates repeat requests from the same client", () => {
    recordClient("192.168.1.50", "Stremio/4.4", "manifest", 1000);
    recordClient("192.168.1.50", "Stremio/4.4", "stream", 2000);
    const clients = listClients();
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({
      ip: "192.168.1.50",
      device: "Stremio",
      requests: 2,
      lastResource: "stream",
    });
    expect(clients[0]?.firstSeen).not.toBe(clients[0]?.lastSeen);
  });

  it("tracks distinct devices separately and sorts by recency", () => {
    recordClient("192.168.1.50", "Stremio/4.4", "manifest", 1000);
    recordClient("192.168.1.60", "Nuvio/1.0", "playback", 2000);
    const clients = listClients();
    expect(clients.map((client) => client.device)).toEqual([
      "Nuvio",
      "Stremio",
    ]);
  });

  it("evicts the least recently seen client at capacity", () => {
    for (let index = 0; index < 100; index += 1) {
      recordClient(`10.0.0.${index}`, "Stremio/4.4", "manifest", 1000 + index);
    }
    recordClient("10.0.0.0", "Stremio/4.4", "stream", 5000); // keep alive
    recordClient("192.168.1.99", "Nuvio/1.0", "manifest", 6000); // evicts
    const clients = listClients();
    expect(clients).toHaveLength(100);
    expect(clients.some((client) => client.ip === "10.0.0.0")).toBe(true);
    expect(clients.some((client) => client.ip === "10.0.0.1")).toBe(false);
  });

  it("copes with missing ip and user-agent", () => {
    recordClient(undefined, undefined, "manifest");
    expect(listClients()[0]).toMatchObject({
      ip: "unknown",
      device: "Unknown device",
    });
  });
});
