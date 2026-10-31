# Agent runtime process isolation

## Goal and scope

Keep typing, window input and UI IPC responsive while Pi prepares a large model request or
runs extension hooks. Pi's pre-request history copy and context transform now run outside
Electron main. This change does not alter Pi's context or compression behaviour, and it does
not optimise how main publishes application state; those are separate follow-ups.

## Design

- `electron/runtime/agent-runtime-process.ts` supervises one `Pi agent runtime` Electron
  utility process. `agent-runtime.ts` runs the existing Pi SDK driver, extension hooks, custom
  view backends and the built-in thread and scheduled-task extensions inside it.
- Main keeps the catalog writer, application and window state, checkpoints, native operations
  and bounded host capabilities. Main no longer loads the Pi SDK: it imports two pure
  subpaths (`@pi-gui/pi-sdk-driver/custom-provider-types`, `/extension-ui-state`) and
  recognises lease conflicts by error code, which is how they arrive over RPC.
- `runtime-rpc.ts` is a private request/reply channel with explicit method allowlists,
  overlapping requests, awaited session events, out-of-band cancellation, clone-safe error
  replies and preserved lease errors. Host callbacks can call back into the runtime without a
  global-queue deadlock. Stop never waits behind a prompt.
- This is event-loop isolation, not a security sandbox or one process per agent. A slow
  extension can still delay other agents in the shared runtime; it no longer blocks the window.

## Failure handling

- **Stray extension errors.** In main, Electron reported an uncaught exception from an
  extension timer and kept running. A utility process exits on the first one instead
  (verified on Electron 37.10.3), which would stop every agent. The runtime installs
  `uncaughtException`/`unhandledRejection` handlers that log and continue, so behaviour
  matches the old in-main runtime. A test throws from an extension timer and checks the same
  runtime keeps serving; it fails without the handlers.
- **Runtime loss.** If the process still exits or crashes, outstanding calls are rejected, each
  open session receives `runFailed` with code `agent_runtime_unavailable`, running UI clears,
  and the draft is kept. Nothing is replayed. A new runtime starts straight away. The store
  forgets each lost session's subscription, queue, extension dialogs and loaded-transcript
  flag, so the next use reopens it from its file in the new runtime. Session leases name the
  dead runtime's PID on the same host, so the new runtime can take them over.
- **Crash loops.** Three losses within 60 seconds stop the restarts
  (`runtime-restart-budget.ts`); the message then asks for an app restart and suggests a
  recently added extension.
- **One session's subscribe fails.** Only that session is detached (`agent_session_detached`)
  and reopens on next use. Previously any subscribe failure disconnected the whole runtime.
- **Shutdown** is bounded (5 seconds) and only terminates the owned process.

## Measurements

All runs used a copy of the real profile, so the installed app and its data were never touched.
The copied 219 MB thread, the installed ACP compression extension, eight real built-in shell
tools returning 30 KB each, nine localhost provider requests and the same 165-character draft
were used each time. Every run kept the exact draft. CPU profilers were **off**
(`PERF_NO_PROFILER=1`), so these numbers include no profiler overhead. Builds alternated:
before (upstream `faf8edd6`), first isolation (`8d15f267`), improved (this branch), twice.

### Typing

| Build           | Key round trip p95 | Key round trip max | Main event-loop max | Main stalls ≥ 50 ms |
| --------------- | ------------------ | ------------------ | ------------------- | ------------------- |
| Before          | 1,125 / 1,099 ms   | 1,906 / 1,468 ms   | 1,824 / 1,351 ms    | 10 / 11             |
| First isolation | 69 / 28 ms         | 135 / 65 ms        | 87 / 53 ms          | 4 / 1               |
| Improved        | 35 / 22 ms         | 124 / 94 ms        | 90 / 71 ms          | 2 / 1               |

Key round trip is automated key dispatch through the renderer and back, not a physical
keyboard. The before runs here are slower than the earlier profiled pair (339–370 ms p95)
because the copied thread has grown since; compare only rows from the same table.

### Memory while working

Working-set memory per process from Electron's `app.getAppMetrics()`, taken at the end of the
typing scenario, in MB (run 1 / run 2):

| Build           | Main        | Agent runtime | Window    | Total         |
| --------------- | ----------- | ------------- | --------- | ------------- |
| Before          | 1,868/1,868 | –             | 335 / 357 | 2,316 / 2,348 |
| First isolation | 285 / 354   | 1,008 / 1,725 | 275 / 273 | 1,656 / 2,473 |
| Improved        | 346 / 424   | 1,713 / 1,617 | 271 / 332 | 2,455 / 2,489 |

GPU and network processes (≈ 110–125 MB together) are included in the totals. Total memory
while working is about the same as before: the memory main used to hold for Pi now sits in the
runtime. The earlier "about half a gigabyte more" figure was measured with three CPU profilers
attached; the window's extra memory in those runs came from profiling, not from this change.

Every provider request had the same size in every build (the first was 179,608,672 bytes), so
compression behaves identically. An earlier run that sent larger requests used a seed profile
that a previous harness run had modified; it was not caused by this change.

### Memory at idle

One empty thread open, no work, last of six samples two seconds apart, in MB (three runs):

| Build           | Main            | Agent runtime   | Total           |
| --------------- | --------------- | --------------- | --------------- |
| Before          | 251 / 186 / 254 | –               | 608 / 447 / 611 |
| First isolation | 249 / 246 / 249 | 165 / 163 / 164 | 773 / 769 / 771 |
| Improved        | 152 / 149 / 192 | 123 / 96 / 166  | 554 / 499 / 717 |

The first isolation version cost about 160 MB at idle because both main and the runtime loaded
the Pi SDK. Main no longer does, which removes about 100 MB, so idle memory is back to roughly
the old level. Loading the SDK entry point alone costs about 82 MB and 0.3–0.5 seconds
(326 modules); the two subpaths main uses now cost about 3 MB.

Raw data: `~/Documents/pi-gui-perf-work/mem-20261030/` (`run.sh`, `idle.sh`, per-run
`report.json`, `resources.json`). Earlier profiled captures are in
`~/Documents/pi-gui-perf-work/live-typing-20261005/runtime-isolation-final/`.

## Verification

- `pnpm check` passed (format, lint, architecture, typecheck, 441 desktop unit tests with one
  platform skip).
- The full Core Electron suite ran: 314 passed, 1 failed. The failure,
  `timeline-pinning.spec.ts` "lands an opened thread at the bottom without a smooth scroll from
  the top", fails the same way on the first isolation commit and is unrelated.
- New tests: a stray extension timer error keeps the same runtime; killing the runtime fails the
  running turn without resending its provider request, keeps the draft, starts a replacement,
  and the next send reaches the provider through it; restart-budget unit tests.
- `session-lease.spec.ts` now expects the runtime process, not main, to hold the lease.

## Remaining limits

- Physical-keyboard typing during the actual Gunz launch has not been tested.
- All agents share one runtime. A slow extension can still hold up other agents.
- This moves the cost of preparing long conversations off the window; it does not make that
  work cheaper. Avoiding Pi's full-history copy before compression is a separate, larger fix.
- Main still copies application state on session events (`app-store.ts` `structuredClone`) and
  scans orchestration children on each event; those are separate changes.
- Packaging was checked on an Apple Silicon Mac only.
