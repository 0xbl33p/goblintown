import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  availableAddons,
  buildToolRegistry,
  normalizeAddonId,
  setAddonEnabled,
} from "../addons.js";
import type { WarrenManifest } from "../types.js";

function manifest(): WarrenManifest {
  return {
    name: "test-town",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    defaultModelGoblin: "gpt-5.4-mini",
    defaultModelOgre: "gpt-5.5",
    defaultModelTroll: "gpt-5.4-mini",
  };
}

describe("addon registry", () => {
  it("lists the Solana onchain add-on without enabling it by default", () => {
    assert.ok(availableAddons.some((a) => a.id === "onchain-solana"));

    const tools = buildToolRegistry(manifest(), {});
    assert.ok(tools.some((t) => t.name === "json.parse"));
    assert.equal(tools.some((t) => t.name === "solana.balance"), false);
  });

  it("normalizes the solana shorthand to the onchain add-on id", () => {
    assert.equal(normalizeAddonId("solana"), "onchain-solana");
    assert.equal(normalizeAddonId("onchain-solana"), "onchain-solana");
    assert.equal(normalizeAddonId("ghost"), null);
  });

  it("adds Solana verifier tools when the add-on is enabled", () => {
    const warren = manifest();
    setAddonEnabled(warren, "solana", true);

    const tools = buildToolRegistry(warren, {});
    assert.ok(tools.some((t) => t.name === "solana.balance"));
    assert.ok(tools.some((t) => t.name === "solana.profile"));
    assert.ok(tools.some((t) => t.name === "solana.transaction"));
    assert.ok(tools.some((t) => t.name === "solana.signatures"));
  });

  it("can disable the Solana add-on after enabling it", () => {
    const warren = manifest();
    setAddonEnabled(warren, "solana", true);
    setAddonEnabled(warren, "solana", false);

    const tools = buildToolRegistry(warren, {});
    assert.equal(tools.some((t) => t.name === "solana.balance"), false);
  });
});
