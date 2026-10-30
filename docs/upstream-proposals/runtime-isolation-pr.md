# Keep Pi execution off Electron’s window event loop

> Body draft only. The current fork test branch also contains unrelated work. Prepare a focused runtime-only patch before opening an upstream PR; do not submit the combined branch as-is.

## Problem

Pi request preparation and synchronous extension hooks share Electron main’s event loop. In long tool-heavy conversations, full-history clones and context preparation delay input dispatch and UI IPC.

## Changes

- Run the existing Pi SDK driver, extension hooks and view backends in one Electron utility process. This does not fork or reimplement Pi’s context/compression behavior.
- Keep windows, native capabilities, checkpoints, application state and the single catalog writer in main. Use explicit method allowlists and clone-safe request/reply messages; do not serialize factories or expose a broad Node API to the renderer.
- Preserve ordered session events, overlapping requests, nested callbacks and out-of-band cancellation. Stop is not queued behind a pending prompt.
- On runtime loss, reject pending/future operations, clear running UI, retain drafts and require restart. Never automatically replay a prompt or tool with an unknown outcome. Bound shutdown to the owned process.

The integration forwards current-upstream model scoping, child-thread/archive and stopped-run catalog operations across the boundary.

## Performance

Two alternating before/after pairs used the same copied 219 MB conversation/compression state, identical renderer assets, eight real shell tools returning 30 KB each, nine localhost requests and exactly 165 draft characters retained. Windows were hidden with background throttling disabled.

| Metric                          | Before: runs 1 / 2 | After: runs 1 / 2 |
| ------------------------------- | ------------------ | ----------------- |
| Automated key-dispatch p95      | 369.8 / 339.0 ms   | 24.2 / 36.8 ms    |
| Maximum key-dispatch round trip | 742.1 / 651.4 ms   | 68.6 / 144.9 ms   |
| Main event-loop stalls ≥50 ms   | 19 / 19            | 0 / 1             |
| Main sampled busy time          | 44.9 / 44.6%       | 14.4 / 15.2%      |

The context hotspot moved to the runtime profile. Selected-transcript IPC was unchanged: 37 sends and approximately 93.5 KB across four sampled payloads in every run. This is not an improvement caused by sending fewer transcript updates.

Peak summed diagnostic RSS increased from approximately 1,937–1,984 MiB to 2,343–2,452 MiB. Busy percentages are per-process sampled values, not total CPU utilization, and must not be added. Profiler setup/teardown is excluded from event-loop measurements.

A separate post-merge check against upstream faf8edd6 completed all eight tools/nine requests/165 keys: dispatch p95 34.9 ms, max 114.7 ms; maximum recorded main event-loop delay 66.2 ms. This single run is not a replacement for the controlled paired comparison.

## Checked in the app

- The blocked-extension regression proves typing and renderer→main IPC return while the runtime remains synchronously blocked until the test releases it.
- Runtime-loss coverage proves the draft stays editable and the pending request is not replayed.
- A packaged extension’s PID matches the separate runtime, not main. Packaged thread creation and the real integrated terminal pass.
- The user tried the standalone updated-fork test build and reported “It felt nice.” This is subjective confirmation; no claim is made that a particular server/game startup was reproduced.

## Tests

- pnpm check passed, including 439 desktop unit tests; one existing platform skip.
- 24 focused Core Electron tests passed: runtime isolation/loss, Stop, attachments during a run, child-thread start/archive, scheduled tools, idle-session release compatibility, model scope, extension cards/dialogs/session isolation/workspace links and transcript selection actions.
- Packaged runtime/thread smoke and integrated terminal: 2 passed.
- Packaged runtime dependency/model-registry verification passed.

## Scope and remaining limits

This PR is intended to contain only the runtime boundary, related regressions and sanitized performance evidence. Idle-session release, model-option caching and other performance work from the combined fork are separate changes.

One shared runtime isolates Electron main’s event loop; it is not a security sandbox or one process per agent. Extensions can still block other agents, application-state publication can still consume main-thread time, and memory increases. Total compression CPU cost is not claimed to fall.

The exact server/game startup and formal visible real-provider conversation proof remain unverified. Packaging proof is macOS arm64, locally ad-hoc signed; it does not establish Windows/Linux packaging or notarized distribution. Private profiles, credentials, conversation content, machine-specific launchers and generated build artifacts must not be included.
