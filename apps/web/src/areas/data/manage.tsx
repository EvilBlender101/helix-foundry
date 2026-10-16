import { useState } from "react";
import { api, number } from "../../api";
import { useWorkspace, useAction } from "../../ui";
import { Button, ConfirmDialog, Dialog } from "../../kit";
import type { DataRemoval, Resource } from "../../../../../packages/shared/src";

// Renaming and deleting a source, a connection or a dataset, from the Data
// page's cards and a dataset's Details.

// What a rename changes: a dataset, one source, or every source of a
// connection (the name its card shows).
export type RenameTarget =
  | { kind: "dataset"; dataset: Resource }
  | { kind: "source"; source: Resource; connection: boolean; name: string };

export function RenameDialog({
  target,
  onClose,
}: {
  target: RenameTarget;
  onClose: () => void;
}) {
  const { id } = useWorkspace(),
    action = useAction();
  const current = target.kind === "dataset" ? target.dataset.name : target.name;
  const [name, setName] = useState(current);
  const trimmed = name.trim();
  const save = () =>
    action.run(async () => {
      if (target.kind === "dataset")
        await api(
          `/workspaces/${id}/datasets/${target.dataset.id}`,
          { name: trimmed },
          "PATCH",
        );
      else
        await api(
          `/workspaces/${id}/sources/${target.source.id}`,
          target.connection ? { connectionName: trimmed } : { name: trimmed },
          "PATCH",
        );
      onClose();
    }, "Renamed");
  return (
    <Dialog
      title={target.kind === "dataset" ? "Rename dataset" : "Rename source"}
      description={
        target.kind === "dataset"
          ? "Queries and dashboards that use the old name keep working."
          : "Its dataset takes the new name too, unless you renamed it yourself."
      }
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            pending={action.pending}
            disabled={!trimmed || trimmed === current}
            onClick={() => void save()}
          >
            Rename
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && trimmed !== current) void save();
        }}
      >
        <label className="hf-field">
          <span>Name</span>
          <input
            data-autofocus
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </form>
    </Dialog>
  );
}

// What a delete removes: sources (their datasets go with them), or one
// dataset that has no source, such as an upload.
export type DeleteTarget = {
  title: string;
  // DELETE request for the API.
  path: string;
  body?: Record<string, unknown>;
  sources: Resource[];
  datasets: Resource[];
};

export function DeleteDataDialog({
  target,
  onClose,
  onDeleted,
}: {
  target: DeleteTarget;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { id } = useWorkspace(),
    action = useAction();
  const rows = target.datasets.reduce(
      (n, d) => n + (d.data.profile?.rows || 0),
      0,
    ),
    snapshots = target.datasets.reduce(
      (n, d) => n + (d.data.versions?.length || 0),
      0,
    );
  const named = target.datasets.map((d) => d.name);
  return (
    <ConfirmDialog
      title={`Delete “${target.title}”?`}
      description="This can’t be undone."
      confirmLabel="Delete"
      tone="danger"
      pending={action.pending}
      onCancel={onClose}
      onConfirm={() =>
        action.run(async () => {
          await api<DataRemoval>(
            `/workspaces/${id}${target.path}`,
            target.body || {},
            "DELETE",
          );
          onClose();
          onDeleted?.();
        }, `Deleted ${target.title}`)
      }
    >
      <div className="cn-delete">
        <p>This removes:</p>
        <ul>
          {target.sources.length > 0 && (
            <li>
              {target.sources.length === 1
                ? "The source, its saved connection settings and its scheduled refreshes"
                : `${target.sources.length} sources, their saved connection settings and their scheduled refreshes`}
            </li>
          )}
          {named.length > 0 ? (
            <li>
              {named.length === 1 ? "The dataset " : "The datasets "}
              <strong>{named.join(", ")}</strong>, with {number(rows)}{" "}
              {rows === 1 ? "row" : "rows"} in {number(snapshots)}{" "}
              {snapshots === 1 ? "snapshot" : "snapshots"}
            </li>
          ) : (
            <li>No datasets: nothing has been imported yet</li>
          )}
          <li>Imports and refreshes still waiting to run</li>
        </ul>
        <p className="muted">
          Your other data is not changed. If a published object type,
          relationship, pipeline or dashboard reads this data, nothing is
          deleted: remove it from the ontology and publish first.
        </p>
      </div>
    </ConfirmDialog>
  );
}
