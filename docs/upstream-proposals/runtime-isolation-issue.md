# Typing freezes while an agent works on a long conversation

## What happens

Typing stutters or stops while an agent runs commands. It gets worse in long conversations
with a lot of command output. Sometimes the whole window feels frozen for a second or more.

The original report was a freeze of several seconds while an agent started a game server.

## Cause

Before each request to the AI, Pi copies the whole conversation and runs extension hooks over
it, including the hooks that shorten long conversations. pi-gui runs Pi in the same process
that handles the window. With a long conversation, that work blocks the window until it ends.

We reproduced it with a copy of a real 219 MB conversation, the conversation-shortening
extension, harmless commands and a local test server. No game server was needed.

## How bad it is

In our automated test, 95% of key presses took up to about 1.1 seconds to get through, and
the slowest took 1.9 seconds. The window's process was blocked for up to 1.8 seconds at a time.

## Suggested fix

Run Pi in a separate background process, so this work can't block the window. In the same
test, 95% of key presses got through within 22–35 ms.
