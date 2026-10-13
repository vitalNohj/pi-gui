import type { SelectedTranscriptRecord } from "./desktop-state";
import type { TranscriptMessage } from "./timeline-types";

// The selected transcript can be tens of MB, and most changes touch one row. Main sends the
// whole record once, then only the rows that changed, as one splice against the version the
// window last received. Transcript rows are replaced (never edited in place) when they change,
// so main finds the changed range by comparing rows by identity.

export type SelectedTranscriptUpdate =
  | {
      readonly kind: "full";
      readonly version: number;
      readonly record: SelectedTranscriptRecord | null;
    }
  | {
      readonly kind: "patch";
      readonly version: number;
      readonly baseVersion: number;
      readonly workspaceId: string;
      readonly sessionId: string;
      // Replace `deleteCount` rows at `start` with `rows`; the result has `length` rows.
      readonly start: number;
      readonly deleteCount: number;
      readonly rows: readonly TranscriptMessage[];
      readonly length: number;
    };

export function selectedTranscriptUpdate(
  previous: SelectedTranscriptRecord | null | undefined,
  previousVersion: number,
  next: SelectedTranscriptRecord | null,
  version: number,
): SelectedTranscriptUpdate {
  if (
    !previous ||
    !next ||
    previous.workspaceId !== next.workspaceId ||
    previous.sessionId !== next.sessionId ||
    previous.schemaInfo !== next.schemaInfo
  ) {
    return { kind: "full", version, record: next };
  }
  const before = previous.transcript;
  const after = next.transcript;
  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && before[start] === after[start]) {
    start += 1;
  }
  let tail = 0;
  while (
    tail < shorter - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  return {
    kind: "patch",
    version,
    baseVersion: previousVersion,
    workspaceId: next.workspaceId,
    sessionId: next.sessionId,
    start,
    deleteCount: before.length - start - tail,
    rows: after.slice(start, after.length - tail),
    length: after.length,
  };
}

export interface SelectedTranscriptSyncState {
  // Null until the window has received a full record, and again after a patch it could not apply.
  readonly version: number | null;
  readonly record: SelectedTranscriptRecord | null;
}

export const initialSelectedTranscriptSync: SelectedTranscriptSyncState = {
  version: null,
  record: null,
};

export type SelectedTranscriptSyncResult =
  | { readonly kind: "applied"; readonly state: SelectedTranscriptSyncState }
  // The patch is not against the version this window holds (for example after a renderer reload);
  // it needs a full record before it can apply further patches.
  | { readonly kind: "needs-full"; readonly state: SelectedTranscriptSyncState };

export function applySelectedTranscriptUpdate(
  current: SelectedTranscriptSyncState,
  update: SelectedTranscriptUpdate,
): SelectedTranscriptSyncResult {
  if (update.kind === "full") {
    return { kind: "applied", state: { version: update.version, record: update.record } };
  }
  const record = current.record;
  if (
    current.version !== update.baseVersion ||
    !record ||
    record.workspaceId !== update.workspaceId ||
    record.sessionId !== update.sessionId ||
    record.transcript.length - update.deleteCount + update.rows.length !== update.length
  ) {
    return { kind: "needs-full", state: { version: null, record } };
  }
  if (update.deleteCount === 0 && update.rows.length === 0) {
    // Keep the same record so the renderer does not redraw for an empty change.
    return { kind: "applied", state: { version: update.version, record } };
  }
  const transcript = [
    ...record.transcript.slice(0, update.start),
    ...update.rows,
    ...record.transcript.slice(update.start + update.deleteCount),
  ];
  return {
    kind: "applied",
    state: { version: update.version, record: { ...record, transcript } },
  };
}
