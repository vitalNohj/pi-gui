# Typing stalls while running tools in long conversations

## Problem

The composer can pause or stop accepting input while a long, tool-heavy conversation runs commands. The original report included multi-second freezes around server/game startup commands.

Profiling a copied large conversation found Pi request preparation and context hooks on Electron main’s JavaScript thread. Full-history cloning and context preparation therefore compete with window input dispatch and host IPC, even when the renderer is not saturated.

## Measured reproduction

Two alternating before/after pairs used the same copied 219 MB conversation and compression state, identical renderer assets, eight real shell tools returning 30 KB each, nine deterministic localhost-provider requests, and the same 165-character draft. Every run retained the exact draft.

| Metric                          | In-main runtime: runs 1 / 2 | Isolated runtime: runs 1 / 2 |
| ------------------------------- | --------------------------- | ---------------------------- |
| Automated key-dispatch p95      | 369.8 / 339.0 ms            | 24.2 / 36.8 ms               |
| Maximum key-dispatch round trip | 742.1 / 651.4 ms            | 68.6 / 144.9 ms              |
| Main event-loop stalls ≥50 ms   | 19 / 19                     | 0 / 1                        |

Windows were hidden with background throttling disabled. Profiler startup/teardown is excluded from event-loop measurements. This is automated input-dispatch latency, not a physical-keyboard measurement; no paid provider or actual game/server was launched.

## Proposed fix

Run the existing Pi SDK driver and extension backends in an Electron utility process. Keep windows, native capabilities, application state, and the single catalog writer in main. Preserve event ordering, Stop/cancellation, callbacks and session ownership across a narrow request/reply boundary rather than changing compression semantics.

## Validation and limits

The updated-fork candidate passes repository checks, focused Electron regressions and packaged-app checks. The user also tried the standalone test build and reported: “It felt nice.” This is positive subjective feedback, not a detailed reproduction log.

The specific server/game startup and a formal visible real-provider conversation journey remain unverified. Runtime isolation adds memory and does not eliminate compression’s CPU cost or guarantee that every hitch is fixed.

Detailed evidence: [runtime isolation report](../agent-runtime-isolation.md).
