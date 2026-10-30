# Agent runtime process isolation

## Goal and scope

Keep typing, window input, and UI IPC responsive while Pi prepares a large model request or
runs extension hooks. The observed pre-request full-history clone and context transform must
execute outside Electron main. This change does not alter Pi's context/compression behavior
or optimize application-state publication; those are independent follow-ups.

Use one Electron utility process for the existing Pi SDK driver and extension backends.
Keep window/platform capabilities and the single catalog writer in main. Use ordered,
request/reply messages with explicit method allowlists; do not serialize factories, evaluate
remote source, replay unknown-outcome operations, or serialize Stop behind a prompt.

## Verification planned before implementation

- **Affected flow:** select a large copied thread, send a prompt that runs eight harmless
  30 KB shell-tool results through a localhost provider and the installed compression
  extension, and type a draft throughout. Reuse `tests/perf/typing-tool-hitches.spec.ts`,
  the same selected thread, workload, and timing instrumentation as the before capture.
  Confirm real tool requests, key count, exact draft contents, main/renderer/runtime CPU
  profiles, and main-event-loop and input-dispatch delay. The installed app and original
  profile must remain untouched.
- **Conversation correctness:** streaming text/tool ordering, two sessions, queues, Stop,
  drafts and persistence. Run focused Core Electron specs, followed by the existing
  real-provider conversation recipe only when it can run without disturbing the user's
  foreground session. A deterministic localhost provider is not real-provider proof.
- **Extension correctness:** commands, flags/preferences and reload, dialogs, provider
  models, orchestration/scheduled tools, custom views and view capability revocation.
  Use existing focused Core specs against the actual Electron build.
- **Failure cases:** initialization/post failures, request rejection, cancellation of
  callbacks, unexpected runtime exit, no automatic operation replay, stale view/sender
  access, and bounded shutdown of only the owned process. Add unit and Electron tests.
- **Repository checks:** `pnpm check`, desktop build, focused `test:e2e:runner` lanes.
  Verify the utility entry is built and packaged with the app.

## Implemented boundary

- `electron/runtime/agent-runtime-process.ts` owns one `Pi agent runtime` utility process.
  `agent-runtime.ts` composes the existing Pi SDK driver, extension hooks, custom view
  backends, and built-in thread/scheduled-task extensions inside that process.
- Main retains the catalog writer, application/window state, checkpoints, native operations,
  and bounded host capabilities. Scheduled-task updates carry data instead of closures.
- The private RPC uses explicit method allowlists, overlapping requests, awaited session
  events, out-of-band cancellation, clone-safe error replies, and preserved lease errors.
  Host callbacks can call back into the runtime without a global-queue deadlock.
- Unexpected runtime loss rejects outstanding/future calls, clears running UI, retains
  the composer draft, and asks for a restart. It never automatically replays a prompt or tool.
  Shutdown is bounded and only terminates the owned utility process.
- This is event-loop isolation, not a security sandbox or one process per agent. An extension
  can still stall other agents in the shared runtime; it no longer shares main's JS thread.

## Measured result

Two alternating before/after pairs used the same copied large thread and compression state,
identical renderer assets, eight real built-in shell tools returning 30 KB each, nine
localhost provider requests, and the same 165-character draft. Every run completed the
provider sequence and asserted the exact draft contents. No Gunz instance or paid provider
was launched. Windows were hidden with background throttling disabled.

| Metric                                     | Before: runs 1 / 2     | Isolated runtime: runs 1 / 2 |
| ------------------------------------------ | ---------------------- | ---------------------------- |
| Automated key-dispatch round trip, p95     | 369.8 / 339.0 ms       | 24.2 / 36.8 ms               |
| Automated key-dispatch round trip, maximum | 742.1 / 651.4 ms       | 68.6 / 144.9 ms              |
| Main event-loop delay, maximum             | 701.5 / 564.5 ms       | 0 recorded / 120.1 ms        |
| Main event-loop delays of at least 50 ms   | 19 / 19                | 0 / 1                        |
| Main sampled busy time                     | 44.9 / 44.6%           | 14.4 / 15.2%                 |
| Renderer sampled busy time                 | 15.5 / 16.1%           | 16.8 / 16.5%                 |
| Runtime sampled busy time                  | Not a separate process | 40.7 / 40.6%                 |
| Key arrival to animation frame, p95        | 20.3 / 21.1 ms         | 20.7 / 21.0 ms               |

The event-loop recorder only retains delays of at least 50 ms. Its scenario-body
measurements exclude profiler startup/teardown; `0 recorded` does not mean zero event-loop
delay. Busy percentages are sampled over each full profile (roughly 18–20 seconds), not
equally long wall-clock windows: before runs take longer because input is blocked. The
operation/key counts are identical. Per-process and inclusive percentages must not be added.

Main's largest inclusive hotspot was `structuredClone` (3,856 / 3,465 ms), with Pi's
`emitContext` path taking 2,914 / 2,509 ms. After isolation, that context path appears in the
runtime profile instead; main's `structuredClone` is 860 / 873 ms. These inclusive times
overlap. Remaining main work includes `handleSessionEvent` and
`projectOrchestrationChildrenForSession`; optimizing their state copies is a separate change.
Selected-transcript IPC stayed at 37 sends with approximately 93.5 KB across four sampled
payloads in every run, so this improvement is not a reduced transcript-update workload.

An owned-process watchdog recorded peak summed diagnostic RSS of approximately
1,937–1,984 MiB before and 2,343–2,452 MiB after. Process separation adds memory and does not
claim to reduce the total CPU cost of compression.

Raw profiles, counters, provider byte counts, watchdog records, and reports are retained
locally under `~/Documents/pi-gui-perf-work/live-typing-20261005/runtime-isolation-final/`
(`before-1`, `after-1`, `before-2`, `after-2`). The directory name is historical. The opt-in
`tests/perf/typing-tool-hitches.spec.ts` documents its environment and retains profile copies;
private session content is not committed with this report.

## Verification and remaining limits

- **Core Electron:** 84 focused tests passed across runtime isolation/loss, Stop, queues,
  drafts, persistence, multiple windows, extension commands/flags/dialogs/custom views,
  orchestration/scheduled tools, and provider/MCP settings. This is not the entire Core suite.
- **RPC:** all 10 unit tests passed, including nested callbacks/cancellation, ordered event
  backpressure, allowlists, lease errors, process loss without replay, and uncloneable inputs
  and results. These also passed as part of the desktop-unit sweep.
- **Packaging:** an ad-hoc-signed, non-notarized macOS arm64 directory build passed the
  packaged UI/thread smoke and executed a local extension whose PID matched the separate
  runtime. The packaged integrated-terminal test and packaged-runtime dependency/model
  verification passed. This does not prove Windows/Linux, notarization, or distribution.
- **Static checks:** `pnpm lint`, `pnpm check:architecture`, and `pnpm typecheck` passed.
  Verification used Node 24.22.2 and repository-local pnpm 10.25.0. The host defaults
  (Node 26 / pnpm 11) are outside the documented setup; packaging initially timed out there.
- **Baseline is not fully green:** `pnpm check` stops at an existing formatting issue in
  `tests/core/composer-attachments-while-running.spec.ts`. Running the subsequent checks
  separately reached the desktop-unit suite: 363 passed, 1 skipped, 1 failed. The failure
  is unchanged `tests/unit/app-operations.spec.ts:75`, where macOS `/var` versus `/private/var`
  path normalization yields an absolute traversal instead of `src/a.ts`. Those files and
  the implementation they exercise are unchanged; neither issue was folded into this fix.
- **Still pending:** physical-keyboard typing during an actual Gunz launch and the visible
  real-provider conversation recipe. These would take foreground input and/or real usage,
  so they were not run while preserving the user's active session. Scripted localhost
  provider traffic and automated Electron input are not substitutes for those proofs.

The installed app and original session data were not replaced or restarted. The candidate
bundle is `apps/desktop/release-runtime-isolation-final/mac-arm64/pi-gui.app`; it must not
replace `/Applications/pi-gui.app` or open the live profile until the user chooses to switch.
