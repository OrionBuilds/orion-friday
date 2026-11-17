// Which registry rows to drop after a scan. Pure (no store, no fs) so it's unit-tested.
//
// scanSources() used to only upsert, so a row for a deleted or renamed file lived forever: the
// index kept advertising skills whose bodies read as "" and pins that pointed at nothing. A row is
// stale when its source was walked THIS pass (root present) but the file wasn't re-found. Rows from
// a source that wasn't scanned (root missing, or dropped from config) are left alone — an unmounted
// drive must not erase the operator's `active` toggles — and builtin ids (no source segment) are
// never touched. Legacy rows without `sourceId` derive it from the id: `skill:<sourceId>:<slug>`.

export interface PrunableRow { id: string; sourceId?: string }

export function rowSource(row: PrunableRow): string | undefined {
  if (row.sourceId) return row.sourceId;
  const parts = row.id.split(":");
  return parts.length >= 3 ? parts[1] : undefined;
}

export function staleRowIds(existing: PrunableRow[], fresh: PrunableRow[], scanned: ReadonlySet<string>): string[] {
  const keep = new Set(fresh.map((r) => r.id));
  return existing
    .filter((r) => {
      const src = rowSource(r);
      return !!src && scanned.has(src) && !keep.has(r.id);
    })
    .map((r) => r.id);
}
