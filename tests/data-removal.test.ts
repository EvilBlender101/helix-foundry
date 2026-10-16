import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../apps/api/src/app.js";
import { config } from "../apps/api/src/config.js";
import { seal } from "../apps/api/src/security.js";
import { datasetPrivacyId } from "../apps/api/src/dataset-privacy.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import {
  datasetNameAliases,
  describeActivity,
  type Resource,
} from "../packages/shared/src/index.js";

// Renaming and deleting connected sources and their datasets.

const opened: { app: Awaited<ReturnType<typeof createApp>>; scope: string }[] =
  [];
afterEach(async () => {
  for (const f of opened.splice(0)) {
    await f.app.close();
    await rm(resolve(config.dataDir, "datasets", f.scope), {
      recursive: true,
      force: true,
    });
  }
});

async function fixture() {
  const store = new MemoryStore(),
    app = await createApp(store);
  await app.ready();
  const scope = (await app.inject("/api/v1/me")).json().workspaces[0].id;
  opened.push({ app, scope });
  const request = (method: any, path: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1/workspaces/${scope}${path}`,
      payload: payload as any,
    });
  const dir = resolve(config.dataDir, "datasets", scope);
  await mkdir(dir, { recursive: true });
  // A source with a dataset, two snapshot versions and their files.
  const seedSource = async (
    name: string,
    data: Record<string, any> = {},
    versions = 2,
  ) => {
    const source = resource(scope, "source", name, {
      kind: "rest",
      secret: seal({ url: "https://example.test/" + name }),
      ...data,
    });
    const datasetId = "source_" + source.id;
    const ids = Array.from({ length: versions }, (_, i) => `${name}_v${i}`);
    await transaction(store, scope, async (tx) => {
      tx.put({ ...source, data: { ...source.data, datasetId } });
      tx.put(
        resource(
          scope,
          "dataset",
          name,
          {
            sourceId: source.id,
            versions: ids,
            activeVersion: ids[0],
            pendingVersion: null,
            profile: { rows: 3, columns: [], sample: [], fingerprint: "x" },
          },
          datasetId,
        ),
      );
      for (const v of ids)
        tx.put(
          resource(
            scope,
            "version",
            name,
            { datasetId, file: v + ".parquet", profile: { rows: 3 } },
            v,
          ),
        );
    });
    for (const v of ids) await writeFile(resolve(dir, v + ".parquet"), "x");
    return { source, datasetId, versions: ids };
  };
  const file = (version: string) => resolve(dir, version + ".parquet");
  return { store, app, scope, request, seedSource, file };
}

describe("renaming sources and datasets", () => {
  it("renames a dataset, bumps its revision and keeps the old name as an alias", async () => {
    const { store, scope, request, seedSource } = await fixture();
    const { datasetId } = await seedSource("helix-foundry-customers");
    const before = (await store.get(scope, datasetId))!;
    const r = await request("PATCH", `/datasets/${datasetId}`, {
      name: "  Customers  ",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().name).toBe("Customers");
    const after = (await store.get(scope, datasetId))!;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.data.formerNames).toEqual(["helix-foundry-customers"]);
    // The description is not marked manual by a rename alone.
    expect(after.data.manualDescription).toBeUndefined();
    expect(datasetNameAliases(after)).toEqual(
      expect.arrayContaining([
        "Customers",
        "helix-foundry-customers",
        "helix_foundry_customers",
      ]),
    );
    const audit = (await store.list(scope, "audit")).find(
      (a) => a.data.change === "rename",
    )!;
    expect(audit.name).toBe("Renamed helix-foundry-customers to Customers");
    expect(describeActivity(audit)).toMatchObject({
      kind: "edit",
      label: "Data renamed",
      ref: { datasetId },
    });
    // The description still saves on its own, as before.
    const described = await request("PATCH", `/datasets/${datasetId}`, {
      description: "People who buy",
    });
    expect(described.json()).toMatchObject({
      name: "Customers",
      description: "People who buy",
      data: { manualDescription: true },
    });
  });

  it("validates names", async () => {
    const { request, seedSource } = await fixture();
    const { source, datasetId } = await seedSource("orders");
    for (const body of [{}, { name: "   " }, { name: "x".repeat(201) }])
      expect(
        (await request("PATCH", `/datasets/${datasetId}`, body)).statusCode,
      ).toBe(400);
    expect(
      (await request("PATCH", `/sources/${source.id}`, { name: "a\nb" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await request("PATCH", `/sources/missing`, { name: "x" })).statusCode,
    ).toBe(404);
  });

  it("renames a source with its dataset and its one-table connection", async () => {
    const { store, scope, request, seedSource } = await fixture();
    const { source, datasetId } = await seedSource("helix-foundry-invoices", {
      connectionId: "connection_a",
      connectionName: "helix-foundry-invoices",
    });
    const r = await request("PATCH", `/sources/${source.id}`, {
      name: "Invoices",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      name: "Invoices",
      data: { connectionName: "Invoices" },
    });
    // Secrets never come back.
    expect(r.json().data.secret).toBeUndefined();
    const stored = (await store.get(scope, source.id))!;
    expect(stored.revision).toBe(source.revision + 1);
    expect(stored.data.secret).toBe(source.data.secret);
    expect((await store.get(scope, datasetId))!.name).toBe("Invoices");
  });

  it("leaves a dataset's own name alone, and renames a whole connection", async () => {
    const { store, scope, request, seedSource } = await fixture();
    const shared = {
      connectionId: "connection_b",
      connectionName: "SlowBooks",
    };
    const a = await seedSource("accounts", shared),
      b = await seedSource("bills", shared);
    await request("PATCH", `/datasets/${a.datasetId}`, { name: "Ledger" });
    await request("PATCH", `/sources/${a.source.id}`, { name: "gl_accounts" });
    expect((await store.get(scope, a.source.id))!.name).toBe("gl_accounts");
    expect((await store.get(scope, a.datasetId))!.name).toBe("Ledger");
    // Not alone in its connection: the connection keeps its name.
    expect((await store.get(scope, a.source.id))!.data.connectionName).toBe(
      "SlowBooks",
    );
    const r = await request("PATCH", `/sources/${b.source.id}`, {
      connectionName: "Accounting",
    });
    expect(r.statusCode).toBe(200);
    for (const s of [a.source, b.source])
      expect((await store.get(scope, s.id))!.data.connectionName).toBe(
        "Accounting",
      );
    expect((await store.get(scope, b.source.id))!.name).toBe("bills");
  });

  it("refuses renames with read-only access", async () => {
    const { app, scope, request, seedSource } = await fixture();
    const { datasetId } = await seedSource("orders");
    const token = (
      await request("POST", "/tokens", { name: "CI", readOnly: true })
    ).json().token;
    const r = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${scope}/datasets/${datasetId}`,
      payload: { name: "x" },
      headers: { authorization: "Bearer " + token },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe("deleting sources and datasets", () => {
  it("removes the source, its dataset, snapshots and pending work, and nothing else", async () => {
    const { store, scope, request, seedSource, file } = await fixture();
    const gone = await seedSource("helix-foundry", {}, 2),
      kept = await seedSource("customers", {}, 1);
    await transaction(store, scope, async (tx) => {
      tx.put(
        resource(scope, "job", "Sync helix-foundry", {
          type: "sync",
          sourceId: gone.source.id,
          status: "queued",
          background: true,
        }),
      );
      tx.put(
        resource(scope, "job", "Sync customers", {
          type: "sync",
          sourceId: kept.source.id,
          status: "queued",
        }),
      );
      tx.put(
        resource(scope, "finding", "Data refreshed: helix-foundry", {
          datasetId: gone.datasetId,
          kind: "refresh",
          dismissed: false,
        }),
      );
      tx.put(
        resource(
          scope,
          "datasetPrivacy",
          "Privacy",
          { datasetId: gone.datasetId, additionalColumns: [] },
          datasetPrivacyId(gone.datasetId),
        ),
      );
    });
    const r = await request("DELETE", `/sources/${gone.source.id}`, {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      sources: [gone.source.id],
      datasets: [gone.datasetId],
      versions: 2,
      credentials: 0,
    });
    expect(await store.get(scope, gone.source.id)).toBeUndefined();
    expect(await store.get(scope, gone.datasetId)).toBeUndefined();
    expect(
      await store.get(scope, datasetPrivacyId(gone.datasetId)),
    ).toBeUndefined();
    for (const v of gone.versions) {
      expect(await store.get(scope, v)).toBeUndefined();
      expect(existsSync(file(v))).toBe(false);
    }
    expect(
      (await store.list(scope, "finding")).filter(
        (f) => f.data.datasetId === gone.datasetId,
      ),
    ).toEqual([]);
    const jobs = await store.list(scope, "job");
    expect(
      jobs.find((j) => j.data.sourceId === gone.source.id)!.data.status,
    ).toBe("canceled");
    expect(
      jobs.find((j) => j.data.sourceId === kept.source.id)!.data.status,
    ).toBe("queued");
    // The other source and its data are untouched.
    expect(await store.get(scope, kept.source.id)).toBeDefined();
    expect((await store.get(scope, kept.datasetId))!.data.activeVersion).toBe(
      kept.versions[0],
    );
    expect(await store.get(scope, kept.versions[0])).toBeDefined();
    expect(existsSync(file(kept.versions[0]))).toBe(true);
    const audit = (await store.list(scope, "audit")).find(
      (a) => a.data.change === "delete",
    )!;
    expect(audit.name).toBe("Deleted helix-foundry");
    expect(describeActivity(audit)).toMatchObject({
      kind: "edit",
      label: "Data deleted",
      ref: {},
    });
    expect(
      (await request("DELETE", `/sources/${gone.source.id}`, {})).statusCode,
    ).toBe(404);
  });

  it("deletes a source that has not imported anything yet", async () => {
    const { store, scope, request } = await fixture();
    const source = resource(scope, "source", "helix-foundry", {
      kind: "rest",
      secret: seal({ url: "https://example.test" }),
    });
    await transaction(store, scope, async (tx) => tx.put(source));
    const r = await request("DELETE", `/sources/${source.id}`, {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ datasets: [], versions: 0 });
    expect(await store.get(scope, source.id)).toBeUndefined();
  });

  it("requires owner access to delete a source", async () => {
    const { store, app, scope, request, seedSource } = await fixture();
    const { source } = await seedSource("orders");
    const me = (await app.inject("/api/v1/me")).json().user.id;
    await transaction(store, "global", async (tx) => {
      const member = (await tx.get(`${me}:${scope}`))!;
      tx.update(member, { ...member.data, role: "editor" });
    });
    expect(
      (await request("DELETE", `/sources/${source.id}`, {})).statusCode,
    ).toBe(403);
    expect(await store.get(scope, source.id)).toBeDefined();
  });

  it("refuses while a published object type, relationship, pipeline or dashboard reads the dataset", async () => {
    const { store, scope, request, seedSource, file } = await fixture();
    const { source, datasetId, versions } = await seedSource("customers"),
      other = await seedSource("orders");
    await transaction(store, scope, async (tx) => {
      const ws = (await tx.get("workspace"))!;
      tx.update(ws, { ...ws.data, activeGeneration: "g1" });
      tx.put(
        resource(scope, "proposal", "Published", {
          status: "published",
          publishedGeneration: "g1",
          bundle: {
            summary: "Workspace",
            assumptions: [],
            catalog: [],
            pipelines: [
              {
                name: "Customer orders",
                inputs: [datasetId, other.datasetId],
                sql: "SELECT 1",
              },
            ],
            ontology: [
              {
                name: "Customer",
                datasetId,
                primaryKey: "id",
                properties: ["id"],
              },
              {
                name: "Order",
                datasetId: other.datasetId,
                primaryKey: "id",
                properties: ["id"],
              },
            ],
            relationships: [
              {
                name: "placed",
                fromType: "Customer",
                toType: "Order",
                fromColumn: "id",
                toColumn: "customer_id",
              },
            ],
            dashboards: [
              {
                name: "Growth",
                widgets: [
                  {
                    title: "Customers",
                    type: "metric",
                    sql: "SELECT count(*) FROM customers",
                    inputs: [datasetId],
                  },
                ],
              },
            ],
            actions: [],
          },
        }),
      );
    });
    const r = await request("DELETE", `/sources/${source.id}`, {});
    expect(r.statusCode).toBe(409);
    const message: string = r.json().error;
    for (const name of [
      "object type “Customer”",
      "relationship “placed”",
      "pipeline “Customer orders”",
      "dashboard “Growth”",
    ])
      expect(message).toContain(name);
    expect(message).not.toContain("“Order”");
    // Nothing changed.
    expect(await store.get(scope, source.id)).toBeDefined();
    expect(await store.get(scope, datasetId)).toBeDefined();
    for (const v of versions) expect(existsSync(file(v))).toBe(true);
    expect(
      (await store.list(scope, "audit")).some(
        (a) => a.data.change === "delete",
      ),
    ).toBe(false);
  });

  it("removes a saved credential only with the last source that uses it", async () => {
    const { store, scope, request, seedSource } = await fixture();
    const credential = resource(
      scope,
      "hostedCredential",
      "Neon",
      {
        provider: "neon",
        kind: "postgres",
        secret: seal({ url: "postgres://u:p@db.example.test/app" }),
      },
      "hosted_abc",
    );
    await transaction(store, scope, async (tx) => tx.put(credential));
    const shared = {
      kind: "postgres",
      hostedConnectionId: credential.id,
      connectionId: "connection_c",
      connectionName: "Neon",
    };
    const a = await seedSource("users", shared),
      b = await seedSource("teams", shared);
    await transaction(store, scope, async (tx) =>
      tx.put(
        resource(
          scope,
          "operation",
          "Connection import",
          {
            fingerprint: "f",
            result: [
              { source: { id: a.source.id } },
              { source: { id: b.source.id } },
            ],
          },
          "connection_c",
        ),
      ),
    );
    const first = await request("DELETE", `/sources/${a.source.id}`, {});
    expect(first.json().credentials).toBe(0);
    expect(await store.get(scope, credential.id)).toBeDefined();
    expect(await store.get(scope, "connection_c")).toBeDefined();
    const last = await request("DELETE", `/sources/${b.source.id}`, {});
    expect(last.statusCode).toBe(200);
    expect(last.json().credentials).toBe(1);
    expect(await store.get(scope, credential.id)).toBeUndefined();
    expect(await store.get(scope, "connection_c")).toBeUndefined();
  });

  it("deletes every source of a connection at once", async () => {
    const { store, scope, request, seedSource } = await fixture();
    const shared = {
      connectionId: "connection_d",
      connectionName: "SlowBooks",
    };
    const a = await seedSource("accounts", shared),
      b = await seedSource("bills", shared),
      other = await seedSource("customers");
    const r = await request("DELETE", `/sources/${a.source.id}`, {
      connection: true,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().sources.sort()).toEqual([a.source.id, b.source.id].sort());
    expect(r.json().versions).toBe(4);
    const left = await store.list(scope, "source");
    expect(left.map((s: Resource) => s.id)).toEqual([other.source.id]);
    expect(
      (await store.list(scope, "audit")).find(
        (x) => x.data.change === "delete",
      )!.name,
    ).toBe("Deleted accounts and bills");
  });

  it("deletes an uploaded dataset, but not one that belongs to a source or a pipeline", async () => {
    const { store, scope, request, seedSource, file } = await fixture();
    const { datasetId: owned } = await seedSource("orders");
    await transaction(store, scope, async (tx) => {
      tx.put(
        resource(
          scope,
          "dataset",
          "upload.csv",
          { versions: ["up_v0"], activeVersion: "up_v0" },
          "upload_ds",
        ),
      );
      tx.put(
        resource(
          scope,
          "version",
          "upload.csv",
          { datasetId: "upload_ds", file: "up_v0.parquet" },
          "up_v0",
        ),
      );
      tx.put(
        resource(
          scope,
          "dataset",
          "Pipeline output",
          { generation: "g1", versions: [] },
          "pipeline_x",
        ),
      );
    });
    await writeFile(file("up_v0"), "x");
    const sourced = await request("DELETE", `/datasets/${owned}`, {});
    expect(sourced.statusCode).toBe(409);
    expect(sourced.json().error).toContain("Delete the source instead");
    expect(
      (await request("DELETE", "/datasets/pipeline_x", {})).statusCode,
    ).toBe(409);
    const r = await request("DELETE", "/datasets/upload_ds", {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      sources: [],
      datasets: ["upload_ds"],
      versions: 1,
      credentials: 0,
    });
    expect(await store.get(scope, "upload_ds")).toBeUndefined();
    expect(existsSync(file("up_v0"))).toBe(false);
    expect(await store.get(scope, owned)).toBeDefined();
  });
});
