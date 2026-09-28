import { describe, expect, it } from "vitest";
import { AGENT_PALETTE_IDS, agentAppearanceSchema, appearanceForPalette, legacyAgentAppearance, randomAgentAppearance, resolveAgentAppearance, agentAvatarUrl, agentAvatarAssetUrl, withAgentAppearance } from "./agent-appearance.js";
import { renderAgentSvg } from "./cliplab/static.js";
import { createAgentSchema, updateAgentSchema } from "./validators/agent.js";

describe("agent appearance", () => {
  it("assigns only the 17 permanent cap palettes", () => {
    for (let i = 0; i < 100; i++) expect(AGENT_PALETTE_IDS).toContain(randomAgentAppearance().paletteId);
    expect(agentAppearanceSchema.safeParse({ schemaVersion: 1, characterVersion: "cap-v1", paletteId: "muted-dream" }).success).toBe(false);
  });
  it("preserves a saved appearance and resolves legacy IDs deterministically", () => {
    const appearance = appearanceForPalette("deep-tide");
    expect(resolveAgentAppearance(appearance, "different-id")).toEqual(appearance);
    expect(resolveAgentAppearance(null, "agent-1")).toEqual(legacyAgentAppearance("agent-1"));
    expect(legacyAgentAppearance("agent-1")).toEqual(legacyAgentAppearance("agent-1"));
    expect(agentAvatarUrl(appearance, 24, 2)).toBe("/api/agent-avatars/cap-v1/deep-tide/rest.png?size=24&scale=2");
  });
  it("prefers an uploaded avatar image over the generated character", () => {
    const appearance = appearanceForPalette("deep-tide");
    const assetId = "11111111-1111-4111-8111-111111111111";
    expect(agentAvatarAssetUrl(assetId)).toBe(`/api/assets/${assetId}/content`);
    expect(withAgentAppearance({ id: "agent-1", appearance, avatarAssetId: assetId }).avatarUrl).toBe(`/api/assets/${assetId}/content`);
    expect(withAgentAppearance({ id: "agent-1", appearance, avatarAssetId: null }).avatarUrl).toBe(agentAvatarUrl(appearance));
    expect(withAgentAppearance({ id: "agent-1", appearance }).avatarUrl).toBe(agentAvatarUrl(appearance));
  });
  it("accepts an avatar asset id or null on agent payloads", () => {
    const assetId = "11111111-1111-4111-8111-111111111111";
    expect(createAgentSchema.parse({ name: "Avatar Agent", adapterType: "process", avatarAssetId: assetId }).avatarAssetId).toBe(assetId);
    expect(updateAgentSchema.parse({ avatarAssetId: null }).avatarAssetId).toBeNull();
    expect(updateAgentSchema.parse({}).avatarAssetId).toBeUndefined();
    expect(updateAgentSchema.safeParse({ avatarAssetId: "not-a-uuid" }).success).toBe(false);
  });
  it("renders without a browser and preserves logical-size detail at high density", () => {
    const appearance = appearanceForPalette("bubblegum-sky");
    // ClipLab v0.2.0 draws an enlarged compact face from 16px; only 12px and
    // below (not a logical size) is body-only.
    const small = renderAgentSvg(appearance, 16, 2);
    expect(small).toContain('width="32"');
    expect(small).toContain('id="agent-face-visible"');
    const eyes = renderAgentSvg(appearance, 24, 2);
    expect(eyes).toContain('width="48"');
    expect(eyes).toContain('id="agent-face-visible"');
    expect(eyes).not.toContain('id="agent-candle-light"');
    expect(renderAgentSvg(appearance, 48, 1)).toContain('id="agent-candle-light"');
    expect(renderAgentSvg(appearance, 24, 2)).toBe(eyes);
  });
});
