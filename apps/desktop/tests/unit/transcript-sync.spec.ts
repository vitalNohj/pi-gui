import { expect, test } from "@playwright/test";
import type { SelectedTranscriptRecord } from "../../contracts/desktop-state";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import {
  applySelectedTranscriptUpdate,
  initialSelectedTranscriptSync,
  selectedTranscriptUpdate,
  type SelectedTranscriptSyncState,
  type SelectedTranscriptUpdate,
} from "../../contracts/transcript-sync";

const createdAt = "2026-10-13T12:00:00.000Z";

function row(id: string, text = id): TranscriptMessage {
  return { kind: "message", id, role: "assistant", text, createdAt };
}

function record(
  transcript: readonly TranscriptMessage[],
  sessionId = "session",
): SelectedTranscriptRecord {
  return { workspaceId: "workspace", sessionId, transcript };
}

// What the renderer holds after receiving `updates` in order, as a structured-clone would deliver them.
function receive(
  updates: readonly SelectedTranscriptUpdate[],
  start: SelectedTranscriptSyncState = initialSelectedTranscriptSync,
) {
  let state = start;
  const results = updates.map((update) => {
    const result = applySelectedTranscriptUpdate(state, structuredClone(update));
    state = result.state;
    return result.kind;
  });
  return { state, results };
}

test("sends only the changed row when one row is replaced", () => {
  const rows = Array.from({ length: 1000 }, (_, index) => row(`r${index}`));
  const before = record(rows);
  const changed = [...rows];
  changed[500] = row("r500", "finished");
  const after = record(changed);

  const first = selectedTranscriptUpdate(undefined, 0, before, 1);
  const second = selectedTranscriptUpdate(before, 1, after, 2);

  expect(first.kind).toBe("full");
  expect(second).toMatchObject({ kind: "patch", start: 500, deleteCount: 1, length: 1000 });
  expect(second.kind === "patch" && second.rows).toEqual([row("r500", "finished")]);
  const { state, results } = receive([first, second]);
  expect(results).toEqual(["applied", "applied"]);
  expect(state.record).toEqual(after);
});

test("applies appends, removals, and a mixed rewrite to the same transcript main holds", () => {
  const a = record([row("a"), row("b"), row("c")]);
  const appended = record([...a.transcript, row("d"), row("e")]);
  const removed = record([
    appended.transcript[0]!,
    appended.transcript[3]!,
    appended.transcript[4]!,
  ]);
  const rewritten = record([row("x"), removed.transcript[1]!, row("y"), row("z")]);
  const emptied = record([]);
  const sequence = [a, appended, removed, rewritten, emptied, a];

  const updates = sequence.map((next, index) =>
    selectedTranscriptUpdate(sequence[index - 1], index, next, index + 1),
  );
  let state = initialSelectedTranscriptSync;
  for (const [index, update] of updates.entries()) {
    const result = applySelectedTranscriptUpdate(state, structuredClone(update));
    expect(result.kind).toBe("applied");
    state = result.state;
    expect(state.record).toEqual(sequence[index]);
  }
});

test("sends the whole transcript when the thread or its schema info changes, or there is none", () => {
  const one = record([row("a")]);
  expect(selectedTranscriptUpdate(one, 1, record([row("a")], "other"), 2).kind).toBe("full");
  expect(
    selectedTranscriptUpdate(
      one,
      1,
      { ...one, schemaInfo: { version: 3, writtenByNewerRuntime: true } },
      2,
    ).kind,
  ).toBe("full");
  expect(selectedTranscriptUpdate(one, 1, null, 2)).toEqual({
    kind: "full",
    version: 2,
    record: null,
  });
  expect(selectedTranscriptUpdate(null, 1, one, 2).kind).toBe("full");
});

test("asks for the whole transcript when a patch is not against the version it holds", () => {
  const a = record([row("a")]);
  const b = record([row("a"), row("b")]);
  const c = record([row("a"), row("b"), row("c")]);
  const full = selectedTranscriptUpdate(undefined, 0, a, 1);
  const missed = selectedTranscriptUpdate(a, 1, b, 2);
  const patch = selectedTranscriptUpdate(b, 2, c, 3);

  // A window that never got the first full record, e.g. after its renderer reloaded.
  expect(receive([patch]).results).toEqual(["needs-full"]);
  // A window that missed a patch keeps showing what it has until the whole transcript arrives.
  const { state, results } = receive([full, patch]);
  expect(results).toEqual(["applied", "needs-full"]);
  expect(state).toEqual({ version: null, record: a });
  // Later patches are skipped too, and the next full record recovers.
  const recovered = receive([missed, selectedTranscriptUpdate(undefined, 0, c, 4)], state);
  expect(recovered.results).toEqual(["needs-full", "applied"]);
  expect(recovered.state.record).toEqual(c);
});

test("keeps the same record for an empty patch so the transcript does not redraw", () => {
  const a = record([row("a")]);
  const first = receive([selectedTranscriptUpdate(undefined, 0, a, 1)]).state;
  const same = applySelectedTranscriptUpdate(
    first,
    selectedTranscriptUpdate(a, 1, record(a.transcript), 2),
  );
  expect(same.kind).toBe("applied");
  expect(same.state.record).toBe(first.record);
  expect(same.state.version).toBe(2);
});
