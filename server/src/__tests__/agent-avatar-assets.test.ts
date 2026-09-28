import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, assets, companies, createDb } from "@paperclipai/db";
import { agentAvatarUrl, appearanceForPalette } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

describe("agent avatar assets", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;

  async function insertAsset(ownerCompanyId: string, contentType = "image/png") {
    const id = randomUUID();
    await db.insert(assets).values({
      id,
      companyId: ownerCompanyId,
      provider: "local_disk",
      objectKey: `assets/agents/${id}`,
      contentType,
      byteSize: 128,
      sha256: "0".repeat(64),
      originalFilename: "avatar.png",
    });
    return id;
  }

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-avatar-assets-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Avatar test", issuePrefix: "AVA" },
      { id: otherCompanyId, name: "Other company", issuePrefix: "OTH" },
    ]);
  }, 30_000);

  afterAll(async () => { await database?.cleanup(); });

  it("sets, replaces, and clears an uploaded avatar and resolves the avatar URL", async () => {
    const service = agentService(db);
    const appearance = appearanceForPalette("deep-tide");
    const firstAssetId = await insertAsset(companyId);
    const created = await service.create(companyId, {
      name: "Portrait",
      role: "engineer",
      adapterType: "process",
      appearance,
      avatarAssetId: firstAssetId,
    });
    expect(created.avatarAssetId).toBe(firstAssetId);
    expect(created.avatarUrl).toBe(`/api/assets/${firstAssetId}/content`);

    const secondAssetId = await insertAsset(companyId, "image/webp");
    const replaced = await service.update(created.id, { avatarAssetId: secondAssetId });
    expect(replaced?.avatarAssetId).toBe(secondAssetId);
    expect(replaced?.avatarUrl).toBe(`/api/assets/${secondAssetId}/content`);
    const listed = await service.list(companyId);
    expect(listed.find((agent) => agent.id === created.id)?.avatarUrl).toBe(`/api/assets/${secondAssetId}/content`);

    const cleared = await service.update(created.id, { avatarAssetId: null });
    expect(cleared?.avatarAssetId).toBeNull();
    expect(cleared?.avatarUrl).toBe(agentAvatarUrl(appearance));
  });

  it("rejects avatar assets from another company on create and update", async () => {
    const service = agentService(db);
    const foreignAssetId = await insertAsset(otherCompanyId);
    await expect(service.create(companyId, {
      name: "Cross company",
      role: "engineer",
      adapterType: "process",
      avatarAssetId: foreignAssetId,
    })).rejects.toMatchObject({ status: 422, message: "Avatar asset must belong to the same company" });

    const agent = await service.create(companyId, { name: "Scoped", role: "engineer", adapterType: "process" });
    await expect(service.update(agent.id, { avatarAssetId: foreignAssetId }))
      .rejects.toMatchObject({ status: 422, message: "Avatar asset must belong to the same company" });
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row.avatarAssetId).toBeNull();
  });

  it("rejects missing and non-image avatar assets", async () => {
    const service = agentService(db);
    const agent = await service.create(companyId, { name: "Validated", role: "engineer", adapterType: "process" });
    await expect(service.update(agent.id, { avatarAssetId: randomUUID() }))
      .rejects.toMatchObject({ status: 404, message: "Avatar asset not found" });
    const documentAssetId = await insertAsset(companyId, "application/pdf");
    await expect(service.update(agent.id, { avatarAssetId: documentAssetId }))
      .rejects.toMatchObject({ status: 422, message: "Avatar asset must be an image" });
  });

  it("falls back to the generated character when the avatar asset is deleted", async () => {
    const service = agentService(db);
    const assetId = await insertAsset(companyId);
    const agent = await service.create(companyId, {
      name: "Deleted avatar",
      role: "engineer",
      adapterType: "process",
      avatarAssetId: assetId,
    });
    await db.delete(assets).where(eq(assets.id, assetId));
    const reloaded = await service.getById(agent.id);
    expect(reloaded?.avatarAssetId).toBeNull();
    expect(reloaded?.avatarUrl).toBe(agentAvatarUrl(reloaded!.appearance));
  });
});
