import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  MAX_PEERS,
  makeCountryName,
  makeCountryCode,
  normalizeCountryCode,
  normalizeCountryConfig,
  normalizeWarrenPeer,
  normalizeWarrenPeers,
  resolveRoleOwners,
  sampleOpenCountries,
  selectPeers,
} from "../country.js";

describe("country peers", () => {
  it("normalizes valid peers and drops invalid rows", () => {
    const many = Array.from({ length: MAX_PEERS + 3 }, (_, i) => ({
      name: `peer${i}`,
      url: `http://localhost:${7000 + i}`,
    }));
    const peers = normalizeWarrenPeers([
      { name: "alpha", url: "http://localhost:7777/" },
      { name: "beta", url: "https://example.com/base/" },
      { name: "bad name!", url: "http://localhost:1" },
      { name: "missing-url" },
      ...many,
    ]);
    assert.equal(peers.length, MAX_PEERS);
    assert.equal(peers[0].url, "http://localhost:7777");
    assert.equal(peers[1].url, "https://example.com/base");
  });

  it("normalizes a single peer and preserves note", () => {
    const peer = normalizeWarrenPeer({
      name: "alpha",
      url: "http://localhost:7777/",
      note: "main dev box",
    });
    assert.ok(peer);
    assert.equal(peer?.name, "alpha");
    assert.equal(peer?.url, "http://localhost:7777");
    assert.equal(peer?.note, "main dev box");
  });

  it("selects peers by name or canonical URL", () => {
    const peers = normalizeWarrenPeers([
      { name: "alpha", url: "http://localhost:7777/" },
      { name: "beta", url: "https://example.com/goblin/" },
    ]);
    const pick = selectPeers(peers, ["alpha", "https://example.com/goblin"]);
    assert.equal(pick.missing.length, 0);
    assert.equal(pick.selected.length, 2);
    assert.equal(pick.selected[0].name, "alpha");
    assert.equal(pick.selected[1].name, "beta");
  });

  it("assigns unclaimed roles to lead by default", () => {
    const resolved = resolveRoleOwners(
      {
        roleOwners: { goblin: "alice" },
        autoAssignLeadExtras: true,
      },
      ["lead", "alice"],
      "lead",
    );
    assert.equal(resolved.goblin, "alice");
    assert.equal(resolved.ogre, "lead");
    assert.equal(resolved.pigeon, "lead");
  });

  it("normalizes country mode config metadata", () => {
    const cfg = normalizeCountryConfig({
      enabled: true,
      countryId: "alpha_123",
      countryName: "Amber Hollow",
      countryCode: "ab12c",
      discoverable: true,
      pendingJoinRequests: [
        {
          id: "req1",
          countryId: "alpha_123",
          countryCode: "AB12C",
          fromName: "peer1",
          fromUrl: "http://localhost:7778",
          fromPublicKey: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
          createdAt: new Date().toISOString(),
          signature: "sig",
        },
      ],
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.countryName, "Amber Hollow");
    assert.equal(cfg.countryCode, "AB12C");
    assert.equal((cfg.pendingJoinRequests ?? []).length, 1);
  });

  it("generates valid country code and filters open-country sample", () => {
    const code = makeCountryCode(12345);
    assert.ok(normalizeCountryCode(code));
    const sample = sampleOpenCountries([
      { memberCount: 1, id: "a" },
      { memberCount: 2, id: "b" },
      { memberCount: 3, id: "c" },
      { memberCount: 4, id: "d" },
    ]);
    assert.equal(sample.some((x) => x.memberCount > 3), false);
  });

  it("generates probabilistically unique country names against existing set", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 120; i++) {
      const name = makeCountryName(taken, 1000 + i);
      assert.equal(taken.has(name.toLowerCase()), false);
      taken.add(name.toLowerCase());
    }
  });
});
