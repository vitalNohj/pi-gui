# pi-gui

The desktop app for the [pi](https://github.com/earendil-works/pi) coding agent.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Latest release](https://img.shields.io/github/v/release/minghinmatthewlam/pi-gui?include_prereleases&label=release)](https://github.com/minghinmatthewlam/pi-gui/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#install)

Run agents in parallel threads, each in its own git worktree if you want one. Review every
change, run the tests in a real terminal, and ship without leaving the window. pi-gui is a
desktop shell around [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
not a separate agent: sessions, models, auth and tools all run through pi itself, so anything
you set up with the pi CLI carries over.

[![An agent in pi-gui fixing a bug, running the tests, then the change open in the review tab](./apps/website/public/media/hero.gif)](./apps/website/public/media/hero.mp4)

<sub>A real run: the agent fixes a bug, adds a test and runs it, then the change opens for review. ([Watch in full quality](./apps/website/public/media/hero.mp4))</sub>

## Performance work in this fork

This fork measures where pi-gui spends its time on a large real profile and fixes the worst
costs, one PR each, with before/after numbers. Fixes are proposed upstream once measured.

### Fixes so far

| PR                                                           | Problem                                                                                              | Result                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [#265](https://github.com/minghinmatthewlam/pi-gui/pull/265) | Model options rebuilt with glob matching on every keystroke and every state push                     | Keystroke to next frame 75 / 155 / 220 ms → 1.3 / 20 / 23 ms (median / p95 / max)   |
| [#267](https://github.com/minghinmatthewlam/pi-gui/pull/267) | The open thread's whole transcript resent several times a second, and again for every one-row change | Unchanged resends 8.8/s × 28 MB → 0; 421.5 MB → 18 KB sent per minute of tool calls |
| [#269](https://github.com/minghinmatthewlam/pi-gui/pull/269) | The unchanged model catalog (813 KB) included in every state push                                    | Push size 1.69 MB → 1.06 MB; catalog data 1.7 GB → 2.4 MB per 30 s                  |

<details>
<summary>#265: model options and glob matching</summary>

Renderer CPU profiles, about 20 s each, typing in the composer of a busy thread (1,812 models,
13 enabled patterns):

|                                                         | Before            | After            |
| ------------------------------------------------------- | ----------------- | ---------------- |
| `buildModelOptions` and callees, share of renderer time | 73.5%             | 13.3%            |
| minimatch compiling globs (`make`)                      | 64.9%             | 11.7%            |
| `#parseGlob` self time                                  | 29.2%             | 5.4%             |
| Renderer idle                                           | 0%                | 68%              |
| Renderer process CPU                                    | ~100%             | ~33%             |
| Keydown dispatch delay, median / p95 / max              | 24 / 77 / 99 ms   | 1.1 / 16 / 34 ms |
| Keystroke to next frame, median / p95 / max             | 75 / 155 / 220 ms | 1.3 / 20 / 23 ms |

10 s renderer profiles with nobody typing and about 16 state snapshots a second, before and
after compiling each glob once:

|                                 | Before  | After |
| ------------------------------- | ------- | ----- |
| `buildModelOptions` and callees | 26.2%   | 1.9%  |
| `#parseGlob` self time          | 10.0%   | 0%    |
| `App` render                    | 29.1%   | 3.9%  |
| Renderer idle                   | 38.7%   | 73.6% |
| Renderer process CPU            | ~63–90% | ~40%  |

</details>

<details>
<summary>#267: transcript sends</summary>

Not resending unchanged transcripts (thread of 925 rows, about 28.6 MB):

|                                                | Before                | After     |
| ---------------------------------------------- | --------------------- | --------- |
| Sends of an unchanged transcript               | 8.8 a second × ~28 MB | 0 in 10 s |
| Main process time spent sending the transcript | 31%                   | 0.1%      |
| Main process busy                              | 39%                   | 4%        |
| Renderer idle                                  | 60%                   | 78%       |

Sending only the changed rows, 60 s each while the open thread ran many tool calls:

|                                       | Before            | After                    |
| ------------------------------------- | ----------------- | ------------------------ |
| Thread size                           | 1,013 rows, 32 MB | 1,386 rows, 39 MB        |
| Whole-transcript sends                | 13                | 0                        |
| Data per send                         | 32.4 MB           | 1.7 KB average, 6 KB max |
| Total data sent                       | 421.5 MB          | 18 KB                    |
| Main process time sending transcripts | 527 ms            | 41 ms                    |

</details>

<details>
<summary>#269: model catalog in state pushes</summary>

30 s each, 2 workspaces, 383 sessions, 1,812 models per workspace. Different numbers of threads
were running, so compare per push:

|                                           | Before  | After                       |
| ----------------------------------------- | ------- | --------------------------- |
| State pushes in 30 s                      | 2,178   | 494                         |
| Size of each push                         | 1.69 MB | 1.06 MB                     |
| Model catalog in each push                | 813 KB  | 0 (sent in 3 of 494 pushes) |
| Catalog data sent in 30 s                 | 1.7 GB  | 2.4 MB                      |
| Main process time sending state, per push | 2.5 ms  | 1.7 ms                      |

</details>

### Survey on a copy of your real profile

`apps/desktop/tests/perf/real-profile-survey.spec.ts` copies your pi-gui profile and pi agent
folder (APFS clones, so it is instant), switches off side effects in the copy (scheduled tasks,
sync and self-update packages), and launches the app on it. It simulates running threads through
the app's test hooks, with no model calls, then runs user scenarios and writes a ranked report
with main-process and renderer CPU profiles, IPC traffic per channel, React render counts per
component, frame times and keystroke latency. The copy is deleted afterwards; your profile is
only read.

```bash
pnpm --filter @pi-gui/desktop build
PERF_REAL_PROFILE=1 PI_APP_TEST_MODE=background \
  pnpm exec playwright test -c apps/desktop/playwright.config.ts \
  apps/desktop/tests/perf/real-profile-survey.spec.ts
```

- Scenarios: `idle`, `typing`, `switch-threads`, `scroll`, `model-picker`, `settings`,
  `open-largest`, `second-window`. Pick some with `PERF_SCENARIOS=idle,typing`.
- Load: each running thread streams text and updates every 50 ms, sets the window title every
  120 ms and runs a tool call with ~30 KB of output every 5 s. `PERF_RUNNING` sets the number of
  background threads (default 2), `PERF_OPEN_RUNNING=0` keeps the open thread idle.
- Output goes to `/tmp/pi-gui-perf/<time>/` (`report.md`, `report.json`, `*.cpuprofile`), or
  `PERF_OUT`. The run is skipped unless `PERF_REAL_PROFILE=1`.

First survey, with #265, #267 and #269 applied (391 threads, 3,628 model entries, 3 running
threads, about 50 state pushes a second):

| Scenario                         | Main busy | Renderer busy | Avg push | Result                                                  |
| -------------------------------- | --------- | ------------- | -------- | ------------------------------------------------------- |
| Idle                             | 52%       | 44%           | 911 KB   | 2,116 React commits in 15 s                             |
| Typing                           | 53%       | 47%           | 912 KB   | Keystroke to frame 13 / 19 / 26 ms (median / p95 / max) |
| Switch threads                   | 65%       | 79%           | 911 KB   | 330–450 ms per switch, p95 frame 46 ms                  |
| Scroll                           | 53%       | 53%           | 911 KB   | p95 frame 18 ms                                         |
| Open the largest thread (193 MB) | 84%       | 44%           | 924 KB   | 2.8 s to open, 258 ms of long tasks                     |
| Second window                    | 69%       | 42%           | 935 KB   | State pushes double to 98 a second                      |

Open findings:

1. The orchestration check in `handleSessionEvent` deep-copies all workspaces and orchestration
   children (648 KB) on every session event to search 10 entries: about 29% of main-process time.
2. Each state push is still about 911 KB, most of it `orchestrationChildren`; unpacking pushes is
   about 15% of renderer time.
3. Every state push re-renders the whole sidebar and rebuilds its model (`buildThreadSidebarModel`,
   `recencyBucketId`): 25,737 thread-row renders in 14 s of typing.
4. Opening a 193 MB thread takes 2.8 s; 22% of main-process time is parsing the session file.
5. A second window doubles state pushes, and copying state per window is 14% of main-process time.
6. Switching threads takes 330–450 ms each.

## Features

### Run agents side by side

Every task gets its own thread. Start it in your checkout or in a fresh git worktree, then
start the next one while it works. The sidebar shows what is running, what finished and what
needs you. Pin threads, group them by time or workspace, and archive the ones you are done with.

<img src="./apps/website/public/media/threads.webp" alt="pi-gui running an agent thread while two other threads work in the sidebar" width="720">

### Review every change before it lands

The Review tab shows exactly what the agent touched. Compare uncommitted work, a branch
against its base, or a single turn, and stage or unstage it file by file.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./apps/website/public/media/review-dark.webp">
  <img src="./apps/website/public/media/review-light.webp" alt="The Review tab showing the diff an agent made to src/price.js" width="720">
</picture>

### Terminal and files in the same window

The workbench beside the conversation holds a real terminal, a file explorer and editor,
the review tab, your worktrees, and tabs from desktop extensions. Each task keeps its own layout.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./apps/website/public/media/terminal-dark.webp">
  <img src="./apps/website/public/media/terminal-light.webp" alt="The integrated terminal running the test suite next to the thread" width="720">
</picture>

### Everything is a keystroke away

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./apps/website/public/media/palette-dark.webp">
  <img src="./apps/website/public/media/palette-light.webp" alt="The command palette listing recent chats and actions" width="720">
</picture>

| Shortcut (macOS; use Ctrl on Linux and Windows)    | Does                                  |
| -------------------------------------------------- | ------------------------------------- |
| <kbd>⌘</kbd> <kbd>K</kbd>                          | Search chats, workspaces and actions  |
| <kbd>⌘</kbd> <kbd>P</kbd>                          | Open any file in the current checkout |
| <kbd>Ctrl</kbd> <kbd>Tab</kbd>                     | Switch between recent threads         |
| <kbd>⌘</kbd> <kbd>1</kbd> to <kbd>9</kbd>          | Jump to a thread in the sidebar       |
| <kbd>⌘</kbd> <kbd>J</kbd>                          | Toggle the terminal                   |
| <kbd>⌘</kbd> <kbd>R</kbd>                          | Toggle the Review tab                 |
| <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>B</kbd>             | Show or hide the workbench            |
| <kbd>Enter</kbd> while a run is going              | Queue a follow-up                     |
| <kbd>⌘</kbd> <kbd>Enter</kbd> while a run is going | Steer the current run                 |

### And the rest

- **Scheduled tasks.** Have pi rerun a prompt on a schedule, such as a weekly dependency
  check, while the app is open.
- **Skills and extensions.** Turn pi skills and extensions on and off, try them from the
  composer, and give desktop extensions their own workbench tabs.
- **Any provider.** Sign in with OAuth, paste an API key, or point at a custom endpoint.
  Pick the model and thinking level per thread.
- **Fork and rewind.** Fork a thread from any message into the same checkout or a new
  worktree, and move around the session tree with `/tree`.
- **Composer.** `@`-mention files, and paste or drop images into the prompt.
- **Threads that run threads.** An agent can start, read and message other threads, which
  show up in the sidebar like any other.
- **Notifications.** Get told when a background thread finishes, fails or needs you.
- **Themes.** Light and dark, plus presets like Catppuccin, Tokyo Night, Nord, Dracula,
  Gruvbox and GitHub.

## Install

pi-gui runs on macOS (Apple Silicon), Linux (x64) and Windows (x64).

Download the latest `.dmg` (macOS), `.AppImage` or `.deb` (Linux), or `.exe` (Windows) from the
[Releases page](https://github.com/minghinmatthewlam/pi-gui/releases).

- **macOS:** drag `pi-gui.app` into Applications. Releases are signed and notarized.
- **Linux:** make the AppImage executable and run it, or install the `.deb`.
- **Windows:** run the setup `.exe`, or use the portable `.exe`. Builds are not code-signed
  yet, so SmartScreen may ask you to confirm.

On macOS you can also use Homebrew:

```bash
brew tap minghinmatthewlam/tap
brew trust minghinmatthewlam/tap
brew install --cask pi-gui
```

Homebrew refuses to load casks from untrusted third-party taps, so the
`brew trust` step is required on first install.

Update with `brew upgrade --cask pi-gui`. A Homebrew upgrade may ask you to
re-confirm macOS permissions or Dock placement. Other installs tell you when a new release is
out and update from the Releases page.

Building from source is for contributors; see [Development](#development).

## Quickstart

1. Install pi-gui and open it.
2. Open **Settings → Providers** and connect a model provider (OAuth or API key).
3. Add a workspace: a local project folder.
4. Click **New thread**, choose **Local** or **Worktree**, and send your first prompt.

pi-gui reads and writes pi's own session files and settings, so threads, credentials and
skills are shared with the pi CLI.

## Architecture

pi-gui is an Electron app with a tight main, preload and renderer boundary, on top of the pi
runtime:

- **Renderer** (`apps/desktop/src`): the React UI, including the timeline, composer,
  workbench and settings. It talks to the main process only through a typed IPC surface.
- **Preload** (`apps/desktop/electron/preload.ts`): the narrow bridge that exposes that IPC
  surface. The renderer gets no broad Node access.
- **Main** (`apps/desktop/electron`): windows, session supervision, worktrees, terminal PTYs,
  scheduled tasks, notifications and persistence.
- **`packages/pi-sdk-driver`**: a thin adapter over `@earendil-works/pi-coding-agent`. It stays
  close to upstream pi and does not fork or reimplement runtime behavior.
- **Session files are the source of truth.** pi stores each session as a JSONL transcript on
  disk, and pi-gui reads those files rather than keeping its own copy.

See [docs/architecture.md](docs/architecture.md) for ownership and boundaries.

## Development

Requires Node 22.19 or newer (CI runs Node 22) and [pnpm](https://pnpm.io) through `corepack`.
`pnpm-lock.yaml` is the authoritative lockfile.

```bash
corepack enable
pnpm install
```

Common commands, from the repo root:

```bash
pnpm dev            # run the desktop app with hot reload
pnpm check          # CI baseline: format, lint, renderer boundaries, types, guard and driver tests
pnpm build          # build the desktop app and the website
pnpm typecheck      # type-check all workspaces
pnpm lint           # correctness rules plus typed promise and unsafe-any checks
pnpm format         # apply the shared formatter
pnpm test           # each workspace's tests (desktop runs the core E2E lane)
pnpm marketing:media  # re-record the README and website media from a real agent run
```

`pnpm check` is the shared local and CI baseline. It does not launch Electron or replace the
desktop, website-build and package CI jobs; see [docs/ci-baseline.md](docs/ci-baseline.md).

Desktop end-to-end tests drive the real Electron app with Playwright, in lanes. `pnpm test`
runs the `core` lane; to run everything:

```bash
pnpm --filter @pi-gui/desktop run test:e2e:all   # core + live + native
```

See [`apps/desktop/README.md`](./apps/desktop/README.md) for the lanes, packaging on each
platform, and how the product media is recorded.

## Repository layout

- `apps/desktop`: the Electron app (renderer, main and preload).
- `apps/website`: [pi-gui.com](https://www.pi-gui.com).
- `packages/pi-sdk-driver`: the adapter over `@earendil-works/pi-coding-agent`.
- `packages/session-driver`: shared session driver types.
- `packages/catalogs`: workspace and session catalog state.
- `packages/extension-ui`: helpers for building desktop extension views.
- `examples/desktop-extensions`: example extensions with their own workbench tabs.
- `video`: the Remotion showcase video.
- `docs`: architecture, CI and design notes.
- `.agents/skills`: checked-in agent skills, including desktop verification.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, verification
expectations and the desktop test lanes. Desktop changes should be verified on the real
Electron app, not only by unit tests.

## Computer use

Native computer use is not built into pi-gui. Desktop and browser control is available
separately through the standalone
[`computer-use-mcp`](https://github.com/minghinmatthewlam/computer-use-mcp) server, which any
MCP-capable agent can use.

## Acknowledgements

Built on [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
and the [pi](https://github.com/earendil-works/pi) runtime and ecosystem.

## License

[MIT](./LICENSE) © Matthew Lam
