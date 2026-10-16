import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Bundle,
  DataRemoval,
  Resource,
} from "../../../packages/shared/src/index.js";
import { config } from "./config.js";
import { publishedBundle } from "./assistant.js";
import { AppError, assert } from "./security.js";
import { resource, transaction, type Store, type Tx } from "./store.js";
import { datasetPrivacyId } from "./dataset-privacy.js";

// Renaming and deleting connected sources and their datasets.

// Earlier names a dataset keeps as table aliases, so saved SQL that reads it
// by an old name still runs after a rename.
const FORMER_NAMES = 10;

export async function renameDataset(
  tx: Tx,
  dataset: Resource,
  name: string,
  description?: string,
) {
  const renamed = name !== dataset.name;
  const formerNames: string[] = renamed
    ? [
        dataset.name,
        ...((dataset.data.formerNames as string[] | undefined) || []),
      ]
        .filter((n, i, all) => n !== name && all.indexOf(n) === i)
        .slice(0, FORMER_NAMES)
    : dataset.data.formerNames;
  return tx.put({
    ...dataset,
    name,
    description: description ?? dataset.description,
    revision: dataset.revision + 1,
    updatedAt: new Date().toISOString(),
    data: {
      ...dataset.data,
      ...(formerNames?.length ? { formerNames } : {}),
      ...(description !== undefined ? { manualDescription: true } : {}),
    },
  });
}

// What the published workspace reads from these datasets, in words:
// object types, relationships, pipelines and dashboards.
export function publishedDependents(bundle: Bundle, datasetIds: Set<string>) {
  const types = bundle.ontology.filter((t) => datasetIds.has(t.datasetId)),
    typeNames = new Set(types.map((t) => t.name));
  return [
    ...types.map((t) => `object type “${t.name}”`),
    ...bundle.relationships
      .filter((r) => typeNames.has(r.fromType) || typeNames.has(r.toType))
      .map((r) => `relationship “${r.name}”`),
    ...bundle.pipelines
      .filter(
        (p) =>
          p.inputs.some((i) => datasetIds.has(i)) ||
          p.nodes.some((n) => n.datasetId && datasetIds.has(n.datasetId)),
      )
      .map((p) => `pipeline “${p.name}”`),
    ...bundle.dashboards
      .filter((d) =>
        d.widgets.some((w) => w.inputs.some((i) => datasetIds.has(i))),
      )
      .map((d) => `dashboard “${d.name}”`),
  ];
}

const list = (items: string[]) =>
  items.length <= 1
    ? items.join("")
    : items.slice(0, -1).join(", ") + " and " + items.at(-1);

// Removes sources (with their datasets) and datasets without a source, in one
// transaction: each dataset's snapshot versions, privacy policy and findings,
// the queued and running jobs that would write them again, and a saved
// connection credential no remaining source uses. Refuses while the published
// workspace reads any of the datasets. Snapshot files go once it commits; no
// other dataset's data is touched.
export async function removeData(
  store: Store,
  scope: string,
  actor: string,
  target: { sourceIds: string[]; datasetIds: string[] },
): Promise<DataRemoval> {
  const files: string[] = [];
  const result = await transaction(store, scope, async (tx) => {
    files.length = 0;
    // Read again on each attempt: a publication in between moves the
    // workspace version, so the commit retries.
    const { bundle } = await publishedBundle(store, scope);
    const sources: Resource[] = [];
    for (const id of target.sourceIds) {
      const s = await tx.get(id);
      assert(s?.kind === "source", "Source unavailable", 404);
      sources.push(s);
    }
    const sourceIds = new Set(sources.map((s) => s.id));
    const all = await tx.list("dataset");
    const datasets = all.filter(
      (d) =>
        target.datasetIds.includes(d.id) ||
        (d.data.sourceId && sourceIds.has(d.data.sourceId)) ||
        sources.some((s) => s.data.datasetId === d.id),
    );
    for (const id of target.datasetIds)
      assert(
        datasets.some((d) => d.id === id),
        "Dataset unavailable",
        404,
      );
    for (const d of datasets) {
      assert(
        !d.data.generation,
        `“${d.name}” is built by a pipeline. Change the pipeline in the ontology instead.`,
        409,
      );
      assert(
        !d.data.sourceId ||
          sourceIds.has(d.data.sourceId) ||
          !(await tx.get(d.data.sourceId)),
        `“${d.name}” belongs to a connected source. Delete the source instead.`,
        409,
      );
    }
    const datasetIds = new Set(datasets.map((d) => d.id));
    const dependents = publishedDependents(bundle, datasetIds);
    if (dependents.length)
      throw new AppError(
        409,
        `${list(datasets.map((d) => `“${d.name}”`)) || "This source"} cannot be deleted: the published workspace reads ${datasets.length > 1 ? "them" : "it"} in ${list(dependents)}. Remove ${dependents.length === 1 ? "it" : "them"} from the ontology and publish first.`,
      );

    let versions = 0;
    // Files another dataset's versions name are never removed.
    const kept = new Set<string>();
    for (const v of await tx.list("version"))
      if (datasetIds.has(v.data.datasetId)) {
        tx.delete(v.id);
        files.push(v.data.file || v.id + ".parquet");
        versions++;
      } else kept.add(v.data.file || v.id + ".parquet");
    for (const d of datasets) {
      // Versions an older release recorded only on the dataset.
      for (const v of (d.data.versions as string[] | undefined) || [])
        if (!kept.has(v + ".parquet")) files.push(v + ".parquet");
      tx.delete(datasetPrivacyId(d.id));
      tx.delete(d.id);
    }
    for (const f of await tx.list("finding"))
      if (
        datasetIds.has(f.data.datasetId) ||
        sourceIds.has(f.data.evidence?.sourceId)
      )
        tx.delete(f.id);
    for (const j of await tx.list("job"))
      if (
        ["queued", "running"].includes(j.data.status) &&
        (sourceIds.has(j.data.sourceId) || datasetIds.has(j.data.datasetId))
      )
        tx.update(j, {
          ...j.data,
          status: "canceled",
          error: "The data was deleted",
        });

    // A saved credential stays while another source still connects with it.
    const remaining = (await tx.list("source")).filter(
      (s) => !sourceIds.has(s.id),
    );
    let credentials = 0;
    for (const id of new Set(
      sources.map((s) => s.data.hostedConnectionId).filter(Boolean),
    ))
      if (!remaining.some((s) => s.data.hostedConnectionId === id)) {
        const credential = await tx.get(id);
        if (credential?.kind === "hostedCredential") {
          tx.delete(id);
          credentials++;
        }
      }
    // An import record whose sources are all gone.
    for (const s of sources) {
      const id = s.data.connectionId;
      if (
        id &&
        !remaining.some((r) => r.data.connectionId === id) &&
        (await tx.get(id))?.kind === "operation"
      )
        tx.delete(id);
    }
    for (const s of sources) tx.delete(s.id);

    const names = [...sources, ...datasets.filter((d) => !d.data.sourceId)]
      .map((r) => r.name)
      .filter((n, i, all) => all.indexOf(n) === i);
    tx.put(
      resource(scope, "audit", "Deleted " + list(names), {
        actor,
        change: "delete",
        sourceIds: [...sourceIds],
        datasetIds: [...datasetIds],
        versions,
        credentials,
      }),
    );
    return {
      sources: [...sourceIds],
      datasets: [...datasetIds],
      versions,
      credentials,
    };
  });
  const dir = resolve(config.dataDir, "datasets", scope);
  // Version ids are generated; a name with a path in it is never removed.
  for (const file of new Set(files))
    if (/^[\w.-]+$/.test(file))
      await rm(resolve(dir, file), { force: true }).catch(() => {});
  return result;
}
