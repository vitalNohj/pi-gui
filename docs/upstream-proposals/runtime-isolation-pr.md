# Keep typing responsive while agents work

## Why

Pi ran in the same process as the window. Before every AI request it copies the whole
conversation and runs extension hooks over it. In a long conversation that blocked typing
for up to two seconds.

## What changed

- **Pi runs in its own background process.** The window process keeps the app state, the
  conversation list, windows and system access. The two talk over a private channel that only
  allows listed methods. Stop still works while a prompt is running.
- **A stray extension error no longer stops agents.** When Pi ran in the window process, an
  error thrown from an extension timer was logged and the app kept going. The background
  process now does the same.
- **If the background process dies, pi-gui starts a new one.** Running work fails with a clear
  message, the draft stays, and nothing is sent again by itself. Each conversation reopens from
  its file the next time you use it. If it dies three times within a minute, pi-gui stops
  restarting it and asks you to restart the app.
- **The window process no longer loads Pi.** It only needs a few small helpers, so it now
  imports those directly. This saves about 100 MB and up to half a second at startup.

## Results

Automated test on a copy of a real 219 MB conversation, with the conversation-shortening
extension, eight harmless commands, a local test server and 165 typed characters. Two runs
each, with no profiler attached. The full draft was kept every time.

| Measurement                         | Before           | After            |
| ----------------------------------- | ---------------- | ---------------- |
| Time for 95% of key presses         | 1,125 / 1,099 ms | 35 / 22 ms       |
| Slowest key press                   | 1,906 / 1,468 ms | 124 / 94 ms      |
| Longest window-process stall        | 1,824 / 1,351 ms | 90 / 71 ms       |
| Window-process stalls of 50 ms+     | 10 / 11          | 2 / 1            |
| Memory, all processes, while typing | 2,316 / 2,348 MB | 2,455 / 2,489 MB |
| Memory, all processes, idle         | 447–611 MB       | 499–717 MB       |

Memory is roughly the same. What Pi used to hold in the window process now sits in the
background process. Requests to the AI were exactly the same size before and after.

## Tests

- `pnpm check` passes, including 441 unit tests.
- The full Electron integration suite: 314 passed. One timeline-scrolling test also fails
  without this change.
- New tests: typing and app requests keep working while an extension blocks the background
  process; an extension timer error leaves the same process running; killing the process stops
  the running turn without resending it, keeps the draft, and the next send works through the
  new process; restart limit unit tests.
- The packaged Mac app starts, runs extensions in the background process and opens a terminal.

## Limits

- All agents share one background process, so a slow extension can still delay other agents.
  It can no longer freeze the window.
- This moves the work off the window process; it does not make preparing long conversations
  cheaper.
- Checked on an Apple Silicon Mac only.
