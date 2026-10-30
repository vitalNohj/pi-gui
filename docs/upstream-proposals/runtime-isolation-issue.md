# Typing sometimes freezes while an agent runs commands

## What happens

Typing can stutter or stop for a moment while an agent is working. It is more noticeable in long conversations with lots of command output. Sometimes it feels like the whole app has frozen.

The original report included pauses lasting several seconds when starting a game/server.

## What we found

The app was handling the window and preparing long conversations for the AI in the same process. When that preparation took a long time, the window could become unresponsive.

We reproduced the problem using a copy of a long conversation and harmless commands. We did not need to launch the game/server to see typing delays.

## Suggested fix

Move agent work into a separate background process so the window can stay responsive while that work is busy.

In our automated comparison, typing-test response time fell from roughly 350 milliseconds to roughly 30 milliseconds. The user also tried a separate test build and said it felt good.

That is an improvement, but it does not prove every reported freeze is fixed.

## Still to check

- Try the exact game/server startup that originally caused the freeze.
- Investigate why one later test sent much more conversation data than earlier tests. We need to check whether the feature that shortens long conversations was working in that test. We do not yet know whether this is a test setup problem or an app problem.

The change also uses more memory. It keeps slow agent work away from the window; it does not remove that work.

[Detailed measurements](../agent-runtime-isolation.md)
