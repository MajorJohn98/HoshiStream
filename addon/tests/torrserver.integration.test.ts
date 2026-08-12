import { describe, expect, it } from "vitest";
import { TorrServerClient } from "../src/torrserver-client.js";

const baseUrl = process.env.TORRSERVER_TEST_URL;

describe.skipIf(!baseUrl)("TorrServer integration", () => {
  it("checks health and parses the torrent list without downloading media", async () => {
    const client = new TorrServerClient(baseUrl!);
    expect(await client.health()).toMatch(/^MatriX\./);
    expect(await client.list()).toBeInstanceOf(Array);
  });
});
