# Keep typing responsive while agents are working

## Why

Some agent work was running in the same process that keeps the app window responsive. Preparing a long conversation for the next AI request could therefore make typing pause.

## What changed

Agent work now runs in a separate background process, leaving the window free to handle typing and clicks.

The change also keeps these safeguards:

- Stop is not stuck waiting behind a running prompt.
- Updates stay in the right order.
- If the background process crashes, the app keeps the draft and shows an error.
- The app does not automatically repeat a command when it cannot tell whether that command already ran.

This changes where the work runs, not how the AI’s conversation is shortened.

## Results

We ran two tests before the change and two after it. Each used the same copied long conversation, eight harmless commands, and the same 165 typed characters. Every run kept the full draft.

| Automated check                   | Before     | After       |
| --------------------------------- | ---------- | ----------- |
| Typing-test response time*        | 339–370 ms | 24–37 ms    |
| App pauses lasting at least 50 ms | 19 per run | 0–1 per run |

*The first row shows the response time that covered 95% of test key presses. These were automated checks, not measurements from a physical keyboard. Test setup time is excluded from the pause counts.

The user also tried the separate test build and said it felt good.

## Checks

- The standard project checks passed, including 439 unit tests; one existing test was skipped for the platform.
- 24 checks in the running app passed, covering typing, Stop, drafts, threads, attachments, and extensions.
- Two checks of the packaged Mac app passed, including its terminal.
- Required files and AI model definitions were verified in the packaged app.

## Trade-offs and remaining checks

- The app used roughly half a gigabyte more memory in these tests.
- Agents still share one background process. A slow extension can hold up other agents, even though it no longer blocks the window in the same way.
- This does not make the underlying agent work cheaper or guarantee that every hitch is fixed.
- The exact game/server startup still needs testing. The automated comparison used harmless commands and a local test server, not a real AI service.
- One later test sent much more conversation data than earlier tests. We need to check whether conversation shortening was working correctly in that test before calling the change ready to submit. This may be a test setup issue or an app issue; it has not been traced yet.
- Packaging was checked on an Apple Silicon Mac, not Windows or Linux.
