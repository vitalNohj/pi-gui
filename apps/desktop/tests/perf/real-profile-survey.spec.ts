/**
 * Performance survey on a copy of a real profile (fork-only diagnostic, not a regression test).
 *
 * Copies the real pi-gui profile and pi agent folder (APFS clones), switches off side effects in
 * the copy, simulates running threads with the app's test hooks (no model calls), runs user
 * scenarios and writes a ranked report.
 *
 *   pnpm --filter @pi-gui/desktop build
 *   PERF_REAL_PROFILE=1 PI_APP_TEST_MODE=background pnpm exec playwright test \
 *     -c apps/desktop/playwright.config.ts apps/desktop/tests/perf/real-profile-survey.spec.ts
 *
 * Options (env): PERF_OUT, PERF_RUNNING (background running threads, default 2),
 * PERF_OPEN_RUNNING (open thread also running, default 1), PERF_FOREGROUND=1 (show window),
 * PERF_KEEP_PROFILE=1, PERF_SCENARIOS (comma list), PERF_THREAD (sessionId to type in).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import {
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  type DesktopHarness,
} from "../helpers/electron-app";

test.skip(process.env.PERF_REAL_PROFILE !== "1", "Set PERF_REAL_PROFILE=1 to run the survey.");

const HOME = homedir();
const SOURCE_USER_DATA = process.env.PERF_USER_DATA ?? join(HOME, "Library/Application Support/pi");
const SOURCE_AGENT = process.env.PERF_AGENT_DIR ?? join(HOME, ".pi/agent");
const OUT =
  process.env.PERF_OUT ??
  join("/tmp/pi-gui-perf", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
const RUNNING = Number(process.env.PERF_RUNNING ?? 2);
const OPEN_RUNNING = process.env.PERF_OPEN_RUNNING !== "0";
const FOREGROUND = process.env.PERF_FOREGROUND === "1";
const ONLY = process.env.PERF_SCENARIOS?.split(",").map((entry) => entry.trim());
// Packages with side effects outside the copy (network sync, self-update, paid keep-warm).
const DISABLED_PACKAGES = ["pi-agentsview-sync", "pi-silent-update", "pi-keepwarm"];

// ---------------------------------------------------------------------------------------------
// Profile copy

interface CatalogSession {
  readonly sessionRef: { readonly workspaceId: string; readonly sessionId: string };
  readonly title: string;
  readonly updatedAt: string;
  readonly sessionFilePath?: string;
}

interface ProfileCopy {
  readonly root: string;
  readonly userDataDir: string;
  readonly agentDir: string;
  readonly sessions: readonly (CatalogSession & { readonly bytes: number })[];
}

function clone(source: string, target: string): void {
  // APFS clone: instant and shares blocks with the original until either side changes.
  execFileSync("cp", ["-cR", source, target]);
}

type JsonObject = Record<string, unknown>;

async function rewriteJson(
  path: string,
  edit: (value: JsonObject) => JsonObject,
  from?: string,
  to?: string,
) {
  if (!existsSync(path)) return;
  let text = await readFile(path, "utf8");
  if (from && to) text = text.split(from).join(to);
  await writeFile(path, JSON.stringify(edit(JSON.parse(text) as JsonObject), null, 2));
}

async function copyProfile(): Promise<ProfileCopy> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-perf-profile-"));
  const userDataDir = join(root, "user-data");
  const agentDir = join(root, "agent");
  clone(SOURCE_USER_DATA, userDataDir);
  clone(SOURCE_AGENT, agentDir);
  for (const name of [
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "DevToolsActivePort",
  ]) {
    await rm(join(userDataDir, name), { force: true });
  }

  // The catalog stores absolute session-file paths: point them at the copy.
  const realAgent = `${SOURCE_AGENT}/`;
  const copyAgent = `${agentDir}/`;
  for (const file of ["catalogs.json", "ui-state.json"]) {
    await rewriteJson(join(userDataDir, file), (value) => value, realAgent, copyAgent);
  }
  // Scheduled tasks would start real (paid) runs.
  await rewriteJson(join(userDataDir, "scheduled-tasks.json"), (value) => ({
    ...value,
    tasks: ((value.tasks ?? []) as JsonObject[]).map((task) => ({ ...task, status: "paused" })),
  }));
  await rewriteJson(join(agentDir, "settings.json"), (value) => ({
    ...value,
    packages: ((value.packages ?? []) as (string | { source: string })[]).map((entry) => {
      const source = typeof entry === "string" ? entry : entry.source;
      return DISABLED_PACKAGES.some((name) => source.includes(name))
        ? { source, extensions: [], skills: [] }
        : entry;
    }),
  }));

  const catalog = JSON.parse(await readFile(join(userDataDir, "catalogs.json"), "utf8")) as {
    sessions: CatalogSession[];
  };
  const sessions = catalog.sessions.map((session) => ({
    ...session,
    bytes:
      session.sessionFilePath && existsSync(session.sessionFilePath)
        ? statSync(session.sessionFilePath).size
        : 0,
  }));
  for (const session of sessions) {
    if (session.sessionFilePath && !session.sessionFilePath.startsWith(agentDir)) {
      throw new Error(`Session file outside the copy: ${session.sessionFilePath}`);
    }
  }
  return { root, userDataDir, agentDir, sessions };
}

// ---------------------------------------------------------------------------------------------
// Instrumentation installed in the app

/** Counts React component renders from production builds via the DevTools hook. */
const REACT_HOOK_SCRIPT = `(() => {
  const counts = new Map();
  let commits = 0;
  const RENDER_TAGS = new Set([0, 1, 11, 15]);
  const nameOf = (fiber) => {
    const type = fiber.type;
    if (typeof type === "function") return type.displayName || type.name || "Anonymous";
    if (type && typeof type === "object") {
      const inner = type.render || type.type;
      return type.displayName || (inner && (inner.displayName || inner.name)) || "Anonymous";
    }
    return "Anonymous";
  };
  window.__perfReact = {
    on: false,
    reset() { counts.clear(); commits = 0; },
    read() { return { commits, renders: Object.fromEntries(counts) }; },
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
    onCommitFiberRoot(_id, root) {
      if (!window.__perfReact.on) return;
      commits += 1;
      const stack = [root.current];
      while (stack.length) {
        const fiber = stack.pop();
        // PerformedWork (flag 1): the component function actually ran in this commit.
        if (RENDER_TAGS.has(fiber.tag) && (fiber.flags & 1)) {
          const name = nameOf(fiber);
          counts.set(name, (counts.get(name) || 0) + 1);
        }
        for (let child = fiber.child; child; child = child.sibling) {
          if ((child.flags | child.subtreeFlags) & 1) stack.push(child);
        }
      }
    },
  };
})();`;

interface SendStats {
  count: number;
  ms: number;
  sampled: number;
  bytes: number;
}

interface LoadStats {
  emitted: number;
  dropped: number;
}

/** State the survey keeps in the main process between evaluate calls. */
type MainGlobal = typeof globalThis & {
  __perf?: {
    sends: Record<string, SendStats>;
    post: (method: string, params?: object) => Promise<object | undefined>;
  };
  __perfLoad?: { stats: LoadStats; stop(): void };
  __PI_APP_TEST_HOOKS?: { emitSessionEvent(event: unknown): Promise<unknown> };
};

/** State the survey keeps in the renderer between evaluate calls. */
type RendererGlobal = Window & {
  __perfReact?: {
    on: boolean;
    reset(): void;
    read(): { commits: number; renders: Record<string, number> };
  };
  __perfFrames?: {
    frames: number[];
    stop: boolean;
    longTaskMs: number;
    longTasks: number;
    observer?: PerformanceObserver;
  };
  __perfKeys?: { samples: KeySample[]; remove(): void };
};

interface KeySample {
  queue: number;
  handler: number;
  toIdle: number;
  toFrame: number | null;
}

async function installMainInstrumentation(harness: DesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(({ BrowserWindow, app }) => {
    const g = globalThis as MainGlobal;
    if (g.__perf) return;
    const v8 = process.getBuiltinModule("node:v8");
    const inspector = process.getBuiltinModule("node:inspector");
    const session = new inspector.Session();
    session.connect();
    const perf = {
      sends: {} as Record<string, SendStats>,
      post: (method: string, params?: object) =>
        new Promise<object | undefined>((resolve, reject) =>
          session.post(method, params, (error, result) =>
            error ? reject(error) : resolve(result),
          ),
        ),
    };
    const patched = new WeakSet<Electron.WebContents>();
    const patch = (window: Electron.BrowserWindow) => {
      const wc = window.webContents;
      if (patched.has(wc)) return;
      patched.add(wc);
      const original = wc.send.bind(wc);
      wc.send = (channel: string, ...args: unknown[]) => {
        const entry = (perf.sends[channel] ??= { count: 0, ms: 0, sampled: 0, bytes: 0 });
        entry.count += 1;
        // Size every 10th message per channel (serializing costs main-process time).
        if (entry.count % 10 === 1) {
          entry.sampled += 1;
          entry.bytes += v8.serialize(args).length;
        }
        const started = performance.now();
        original(channel, ...args);
        entry.ms += performance.now() - started;
      };
    };
    for (const window of BrowserWindow.getAllWindows()) patch(window);
    app.on("browser-window-created", (_event, window) => patch(window));
    g.__perf = perf;
  });
}

async function startMain(harness: DesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(async ({ app }) => {
    const perf = (globalThis as MainGlobal).__perf!;
    perf.sends = {};
    app.getAppMetrics(); // resets percentCPUUsage
    const post = perf.post;
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 500 });
    await post("Profiler.start");
  });
}

async function stopMain(harness: DesktopHarness) {
  return harness.electronApp.evaluate(async ({ app }) => {
    const perf = (globalThis as MainGlobal).__perf!;
    const { profile } = (await perf.post("Profiler.stop")) as { profile: unknown };
    const processes = app.getAppMetrics().map((metric) => ({
      type: metric.type,
      name: metric.name ?? metric.serviceName ?? "",
      cpuPercent: metric.cpu.percentCPUUsage,
      memoryMB: Math.round(metric.memory.workingSetSize / 1024),
    }));
    // What main actually keeps, as opposed to garbage not yet collected.
    await perf.post("HeapProfiler.collectGarbage");
    const usage = process.memoryUsage();
    const mainAfterGc = {
      heapUsedMB: Math.round(usage.heapUsed / 1048576),
      externalMB: Math.round((usage.external + usage.arrayBuffers) / 1048576),
      rssMB: Math.round(usage.rss / 1048576),
    };
    return { profile, sends: perf.sends, processes, mainAfterGc };
  });
}

async function startRenderer(window: Page, cdp: CDPSession): Promise<void> {
  await window.evaluate(() => {
    const g = globalThis.window as RendererGlobal;
    g.__perfReact?.reset();
    if (g.__perfReact) g.__perfReact.on = true;
    const frames: number[] = [];
    let last = performance.now();
    const state = { frames, stop: false, longTaskMs: 0, longTasks: 0 };
    g.__perfFrames = state;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (!state.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTaskMs += entry.duration;
        state.longTasks += 1;
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
    g.__perfFrames.observer = observer;
  });
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  await cdp.send("Profiler.start");
}

async function stopRenderer(window: Page, cdp: CDPSession) {
  const { profile } = await cdp.send("Profiler.stop");
  const page = await window.evaluate(() => {
    const g = globalThis.window as RendererGlobal;
    const state = g.__perfFrames!;
    state.stop = true;
    state.observer?.disconnect();
    if (g.__perfReact) g.__perfReact.on = false;
    const frames = [...state.frames].sort((a, b) => a - b);
    return {
      visibility: document.visibilityState,
      frames: frames.length,
      p95FrameMs: frames[Math.floor(frames.length * 0.95)] ?? 0,
      maxFrameMs: frames.at(-1) ?? 0,
      longTasks: state.longTasks,
      longTaskMs: state.longTaskMs,
      react: g.__perfReact?.read() ?? null,
    };
  });
  return { profile, page };
}

// ---------------------------------------------------------------------------------------------
// Simulated running threads (no model calls)

interface LoadThread {
  readonly sessionRef: { readonly workspaceId: string; readonly sessionId: string };
  readonly workspace: {
    readonly workspaceId: string;
    readonly path: string;
    readonly displayName: string;
  };
  readonly title: string;
}

async function startLoad(harness: DesktopHarness, threads: readonly LoadThread[]): Promise<void> {
  await harness.electronApp.evaluate(
    (_, input) => {
      const g = globalThis as MainGlobal;
      g.__perfLoad?.stop();
      const hooks = g.__PI_APP_TEST_HOOKS!;
      let pending = 0;
      const stats = { emitted: 0, dropped: 0 };
      const emit = (event: unknown) => {
        // A real driver keeps emitting while main is busy; cap the backlog so the run can finish.
        if (pending > 500) {
          stats.dropped += 1;
          return;
        }
        pending += 1;
        stats.emitted += 1;
        hooks
          .emitSessionEvent(event)
          .catch(() => undefined)
          .finally(() => (pending -= 1));
      };
      const timers: ReturnType<typeof setInterval>[] = [];
      const filler = "src/example/file.ts:42: const value = compute(input, options); // match\n";
      const toolOutput = filler.repeat(Math.ceil(30_000 / filler.length));
      input.threads.forEach((thread, threadIndex) => {
        const runId = `perf-run-${threadIndex}-${Date.now()}`;
        const snapshot = (preview: string) => ({
          ref: thread.sessionRef,
          workspace: thread.workspace,
          title: thread.title,
          status: "running",
          updatedAt: new Date().toISOString(),
          preview,
          runningRunId: runId,
        });
        const base = () => ({
          sessionRef: thread.sessionRef,
          timestamp: new Date().toISOString(),
          runId,
        });
        const updated = (preview: string) =>
          emit({ ...base(), type: "sessionUpdated", snapshot: snapshot(preview) });
        updated("working");
        let tick = 0;
        // Streamed text: a delta and a session update every 50 ms, as the driver emits them.
        timers.push(
          setInterval(() => {
            tick += 1;
            emit({ ...base(), type: "assistantDelta", text: `word${tick} ` });
            updated(`word${tick}`);
            if (tick % 80 === 0) emit({ ...base(), type: "assistantMessageEnded" });
          }, 50),
        );
        // Window-title spinner extension: a title request every 120 ms.
        const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let frame = 0;
        timers.push(
          setInterval(() => {
            frame = (frame + 1) % frames.length;
            emit({
              ...base(),
              type: "hostUiRequest",
              request: {
                kind: "title",
                requestId: `perf-title-${threadIndex}-${frame}`,
                title: `${frames[frame]} π ${thread.title.slice(0, 30)}`,
              },
            });
          }, 120),
        );
        // A tool call every 5 s with ~30 KB of output.
        let call = 0;
        timers.push(
          setInterval(() => {
            call += 1;
            const callId = `perf-call-${threadIndex}-${call}-${Date.now()}`;
            emit({
              ...base(),
              type: "toolStarted",
              toolName: "bash",
              callId,
              input: { command: `rg -n compute src # ${call}` },
            });
            updated("running tool");
            setTimeout(() => {
              emit({
                ...base(),
                type: "toolFinished",
                callId,
                success: true,
                output: { content: [{ type: "text", text: toolOutput }] },
              });
              updated("tool finished");
            }, 1500);
          }, 5000),
        );
      });
      g.__perfLoad = {
        stats,
        stop() {
          for (const timer of timers) clearInterval(timer);
        },
      };
    },
    { threads },
  );
}

async function stopLoad(harness: DesktopHarness) {
  return harness.electronApp.evaluate(() => {
    const load = (globalThis as MainGlobal).__perfLoad;
    load?.stop();
    return load?.stats ?? null;
  });
}

// ---------------------------------------------------------------------------------------------
// Profile analysis

interface CpuProfile {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    children?: number[];
  }[];
  samples: number[];
  timeDeltas: number[];
}

function analyzeProfile(profile: CpuProfile, top = 15) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id);
  const label = (id: number) => {
    const frame = byId.get(id)!.callFrame;
    const file = frame.url.split("/").slice(-2).join("/");
    return `${frame.functionName || "(anonymous)"}${file ? ` ${file}:${frame.lineNumber + 1}` : ""}`;
  };
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  let total = 0;
  let idle = 0;
  profile.samples.forEach((sample, index) => {
    const ms = (profile.timeDeltas[index] ?? 0) / 1000;
    total += ms;
    const leaf = byId.get(sample)!.callFrame.functionName;
    if (leaf === "(idle)") {
      idle += ms;
      return;
    }
    const leafLabel = label(sample);
    self.set(leafLabel, (self.get(leafLabel) ?? 0) + ms);
    const seen = new Set<string>();
    for (let id: number | undefined = sample; id !== undefined; id = parent.get(id)) {
      const name = label(id);
      if (name === "(root)" || seen.has(name)) continue;
      seen.add(name);
      inclusive.set(name, (inclusive.get(name) ?? 0) + ms);
    }
  });
  const rank = (map: Map<string, number>) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([fn, ms]) => ({
        fn,
        ms: Math.round(ms),
        pct: total ? +((ms / total) * 100).toFixed(1) : 0,
      }));
  return {
    totalMs: Math.round(total),
    busyPct: total ? +(((total - idle) / total) * 100).toFixed(1) : 0,
    self: rank(self),
    inclusive: rank(inclusive),
  };
}

// ---------------------------------------------------------------------------------------------
// Scenario runner

interface ScenarioResult {
  readonly name: string;
  readonly seconds: number;
  readonly notes: Record<string, unknown>;
  readonly main: ReturnType<typeof analyzeProfile>;
  readonly renderer: ReturnType<typeof analyzeProfile>;
  readonly sends: Record<string, { count: number; ms: number; sampled: number; bytes: number }>;
  readonly processes: { type: string; name: string; cpuPercent: number; memoryMB: number }[];
  readonly page: Awaited<ReturnType<typeof stopRenderer>>["page"];
  readonly load: LoadStats | null;
}

async function measure(
  name: string,
  harness: DesktopHarness,
  window: Page,
  cdp: CDPSession,
  body: () => Promise<Record<string, unknown>>,
): Promise<ScenarioResult> {
  await startMain(harness);
  await startRenderer(window, cdp);
  const started = Date.now();
  const notes = await body();
  const seconds = (Date.now() - started) / 1000;
  const renderer = await stopRenderer(window, cdp);
  const main = await stopMain(harness);
  const load = await harness.electronApp.evaluate(() => {
    const stats = (globalThis as MainGlobal).__perfLoad?.stats;
    return stats ? { ...stats } : null;
  });
  await writeFile(join(OUT, `${name}.main.cpuprofile`), JSON.stringify(main.profile));
  await writeFile(join(OUT, `${name}.renderer.cpuprofile`), JSON.stringify(renderer.profile));
  return {
    name,
    seconds,
    notes,
    main: analyzeProfile(main.profile as CpuProfile),
    renderer: analyzeProfile(renderer.profile as unknown as CpuProfile),
    sends: main.sends,
    processes: main.processes,
    mainAfterGc: main.mainAfterGc,
    page: renderer.page,
    load,
  };
}

async function waitForThreadSettled(window: Page, sessionId: string, timeout = 120_000) {
  await expect
    .poll(async () => (await getDesktopState(window)).selectedSessionId, { timeout })
    .toBe(sessionId);
  await expect(window.getByTestId("transcript-skeleton")).toHaveCount(0, { timeout });
  await expect(window.getByTestId("timeline-pane")).toHaveAttribute("data-layout", "settled", {
    timeout,
  });
}

/**
 * One thread switch split into phases, all in renderer time from the click: main confirms the
 * selection (state push), the transcript arrives, the skeleton is gone, rows are on screen, and
 * the layout has settled. Also records how big the transcript send was.
 */
async function openThreadPhased(
  window: Page,
  ref: { workspaceId: string; sessionId: string },
) {
  await window.evaluate((sessionId) => {
    const g = globalThis.window as RendererGlobal & { __perfSwitch?: Record<string, unknown> };
    const t: Record<string, number | null> = {
      clickAt: null,
      selected: null,
      skeletonSeen: null,
      transcript: null,
      transcriptRows: null,
      transcriptKB: null,
      transcriptHandledMs: null,
      noSkeleton: null,
      rows: null,
      settled: null,
    };
    // Rows already on screen belong to the previous thread; only new rows count.
    for (const row of document.querySelectorAll(".timeline__virtual-row"))
      (row as HTMLElement).dataset.perfOld = "1";
    let start = performance.now();
    const armedAt = start;
    document.addEventListener(
      "click",
      () => {
        start = performance.now();
        t.clickAt = start - armedAt;
      },
      { capture: true, once: true },
    );
    const offState = g.piApp!.onStateChanged((state) => {
      if (t.selected === null && state.selectedSessionId === sessionId)
        t.selected = performance.now() - start;
    });
    const offTranscript = g.piApp!.onSelectedTranscriptChanged((payload) => {
      if (t.transcript !== null || !payload || payload.sessionId !== sessionId) return;
      const at = performance.now();
      t.transcript = at - start;
      const rows = "transcript" in payload ? payload.transcript : null;
      t.transcriptRows = rows ? rows.length : null;
      // Sized after the switch settles, so the probe doesn't add work inside the measured window.
      (g as unknown as { __perfSwitchPayload?: unknown }).__perfSwitchPayload = payload;
      // Listener order: this runs before or after the app's own handler; queue a task to see when
      // the app's synchronous handling of the push is done.
      setTimeout(() => (t.transcriptHandledMs = performance.now() - start), 0);
    });
    const poll = () => {
      const now = performance.now() - start;
      const pane = document.querySelector('[data-testid="timeline-pane"]') as HTMLElement | null;
      const skeleton = document.querySelector('[data-testid="transcript-skeleton"]');
      if (skeleton && t.skeletonSeen === null) t.skeletonSeen = now;
      const newRows = document.querySelector(".timeline__virtual-row:not([data-perf-old])");
      if (t.selected !== null) {
        if (t.noSkeleton === null && !skeleton && (newRows || t.skeletonSeen !== null))
          t.noSkeleton = now;
        if (t.rows === null && newRows) t.rows = now;
        if (t.settled === null && newRows && !skeleton && pane?.dataset.layout === "settled") {
          t.settled = now;
          offState();
          offTranscript();
          return;
        }
      }
      if (now < 30_000) requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
    g.__perfSwitch = t;
  }, ref.sessionId);
  const opened = await openThread(window, ref);
  await window.waitForTimeout(50);
  const phases = await window.evaluate(() => {
    const g = globalThis.window as unknown as {
      __perfSwitch?: Record<string, number | null>;
      __perfSwitchPayload?: unknown;
    };
    const t = g.__perfSwitch ?? {};
    if (g.__perfSwitchPayload)
      t.transcriptKB = Math.round(JSON.stringify(g.__perfSwitchPayload).length / 1024);
    g.__perfSwitchPayload = undefined;
    return t;
  });
  const round = (value: number | null | undefined) =>
    value === null || value === undefined ? null : Math.round(value);
  return {
    ...opened,
    phases: Object.fromEntries(
      Object.entries(phases).map(([key, value]) => [
        key,
        key.endsWith("Rows") || key.endsWith("KB") ? value : round(value),
      ]),
    ),
  };
}

async function openThread(window: Page, ref: { workspaceId: string; sessionId: string }) {
  const started = Date.now();
  const row = window.locator(`[data-session-id="${ref.sessionId}"] .session-row__select`);
  const viaSidebar = (await row.count()) > 0 && (await row.first().isVisible());
  if (viaSidebar) {
    await row.first().click();
  } else {
    await window.evaluate((target) => globalThis.window.piApp!.selectSession(target), ref);
  }
  await waitForThreadSettled(window, ref.sessionId);
  return { ms: Date.now() - started, viaSidebar };
}

/** Per keystroke: wait before the handler ran, handler time, and time until the app was idle. */
async function installKeyLatency(window: Page) {
  await window.evaluate(() => {
    const g = globalThis.window as RendererGlobal;
    const composer = document.querySelector('[data-testid="composer"]')!;
    const samples: KeySample[] = [];
    let pending: { ts: number; start: number } | null = null;
    const onKeyDown = (event: Event) => {
      pending = { ts: event.timeStamp, start: performance.now() };
    };
    const onInput = () => {
      const keyed = pending;
      pending = null;
      if (!keyed) return;
      const inputAt = performance.now();
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        const idleAt = performance.now();
        const sample: KeySample = {
          queue: keyed.start - keyed.ts,
          handler: inputAt - keyed.start,
          toIdle: idleAt - keyed.ts,
          toFrame: null,
        };
        samples.push(sample);
        requestAnimationFrame(() => {
          sample.toFrame = performance.now() - keyed.ts;
        });
      };
      channel.port2.postMessage(0);
    };
    composer.addEventListener("keydown", onKeyDown, true);
    composer.addEventListener("input", onInput, true);
    g.__perfKeys = {
      samples,
      remove() {
        composer.removeEventListener("keydown", onKeyDown, true);
        composer.removeEventListener("input", onInput, true);
      },
    };
  });
}

async function readKeyLatency(window: Page) {
  return window.evaluate(() => {
    const keys = (globalThis.window as RendererGlobal).__perfKeys!;
    keys.remove();
    const samples = keys.samples;
    const stat = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const at = (q: number) =>
        +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0).toFixed(1);
      return { p50: at(0.5), p95: at(0.95), max: at(1) };
    };
    const frames = samples
      .map((sample) => sample.toFrame)
      .filter((value): value is number => value !== null);
    return {
      keys: samples.length,
      waitBeforeHandlerMs: stat(samples.map((sample) => sample.queue)),
      handlerMs: stat(samples.map((sample) => sample.handler)),
      keyToIdleMs: stat(samples.map((sample) => sample.toIdle)),
      keyToFrameMs: frames.length ? stat(frames) : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Report

function kb(bytes: number) {
  return Math.round(bytes / 1024);
}

function renderReport(
  results: readonly ScenarioResult[],
  startup: Record<string, unknown>,
  setup: Record<string, unknown>,
) {
  const lines: string[] = ["# pi-gui performance survey (real profile copy)", ""];
  lines.push("## Setup", "", "```json", JSON.stringify(setup, null, 2), "```", "");
  lines.push("## Startup", "", "```json", JSON.stringify(startup, null, 2), "```", "");
  lines.push("## Summary", "");
  lines.push(
    "| Scenario | s | Main busy | Renderer busy | State pushes/s | Avg push KB | Transcript sends/s | React commits | Long tasks ms | p95 frame ms |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const result of results) {
    const state = result.sends["pi-gui:state-changed"];
    const transcript = result.sends["pi-gui:selected-transcript-changed"];
    lines.push(
      `| ${result.name} | ${result.seconds.toFixed(0)} | ${result.main.busyPct}% | ${result.renderer.busyPct}% | ${((state?.count ?? 0) / result.seconds).toFixed(1)} | ${state?.sampled ? kb(state.bytes / state.sampled) : 0} | ${((transcript?.count ?? 0) / result.seconds).toFixed(1)} | ${result.page.react?.commits ?? "n/a"} | ${result.page.longTaskMs.toFixed(0)} | ${result.page.p95FrameMs.toFixed(0)} |`,
    );
  }
  lines.push("");
  for (const result of results) {
    lines.push(`## ${result.name}`, "");
    lines.push(
      "```json",
      JSON.stringify(
        { notes: result.notes, load: result.load, page: { ...result.page, react: undefined } },
        null,
        2,
      ),
      "```",
      "",
    );
    lines.push(
      "**IPC to renderer**",
      "",
      "| Channel | Sends | Per s | Avg KB (sampled) | Est. MB | Send ms |",
      "|---|---|---|---|---|---|",
    );
    for (const [channel, entry] of Object.entries(result.sends).sort(
      (a, b) => b[1].count - a[1].count,
    )) {
      const avg = entry.sampled ? entry.bytes / entry.sampled : 0;
      lines.push(
        `| ${channel} | ${entry.count} | ${(entry.count / result.seconds).toFixed(1)} | ${kb(avg)} | ${((avg * entry.count) / 1048576).toFixed(1)} | ${entry.ms.toFixed(0)} |`,
      );
    }
    lines.push("");
    if (result.page.react) {
      const renders = Object.entries(result.page.react.renders)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25);
      lines.push(
        `**React renders** (${result.page.react.commits} commits)`,
        "",
        "| Component | Renders |",
        "|---|---|",
      );
      for (const [component, count] of renders) lines.push(`| ${component} | ${count} |`);
      lines.push("");
    }
    for (const [proc, analysis] of [
      ["Main", result.main],
      ["Renderer", result.renderer],
    ] as const) {
      lines.push(
        `**${proc} CPU profile** (busy ${analysis.busyPct}% of ${analysis.totalMs} ms)`,
        "",
      );
      lines.push("| Inclusive | ms | % |  | Self | ms | % |", "|---|---|---|---|---|---|---|");
      for (
        let index = 0;
        index < Math.max(analysis.inclusive.length, analysis.self.length);
        index += 1
      ) {
        const inc = analysis.inclusive[index];
        const own = analysis.self[index];
        lines.push(
          `| ${inc ? `\`${inc.fn}\`` : ""} | ${inc?.ms ?? ""} | ${inc?.pct ?? ""} |  | ${own ? `\`${own.fn}\`` : ""} | ${own?.ms ?? ""} | ${own?.pct ?? ""} |`,
        );
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------

test("performance survey on a copy of the real profile", async () => {
  test.setTimeout(30 * 60_000);
  await mkdir(OUT, { recursive: true });
  const copy = await copyProfile();
  const scenarios = (name: string) => !ONLY || ONLY.includes(name);
  const results: ScenarioResult[] = [];
  let harness: DesktopHarness | undefined;
  let memoryGuard: ReturnType<typeof setInterval> | undefined;
  try {
    const launchStarted = Date.now();
    harness = await launchDesktop(copy.userDataDir, {
      agentDir: copy.agentDir,
      testMode: FOREGROUND ? "foreground" : "background",
      envOverrides: {
        PI_APP_INITIAL_WORKSPACES: undefined,
        PI_SESSION_FILE: undefined,
        PI_SESSION_ID: undefined,
        PI_MODEL: undefined,
        PI_PROVIDER: undefined,
        PI_REASONING_LEVEL: undefined,
        PI_SKIP_VERSION_CHECK: "1",
      },
    });
    let window = await harness.firstWindow();
    const firstWindowMs = Date.now() - launchStarted;
    // Safeguard: a test copy that falls behind can grow without bound, so stop it at a cap.
    const MEMORY_CAP_MB = Number(process.env.PERF_MEMORY_CAP_MB ?? 3072);
    const launched = harness;
    memoryGuard = setInterval(() => {
      void launched.electronApp
        .evaluate(({ app }) =>
          Math.max(...app.getAppMetrics().map((metric) => metric.memory.workingSetSize / 1024)),
        )
        .then(async (peakMB) => {
          if (peakMB <= MEMORY_CAP_MB) return;
          console.log(
            `Stopped: a process reached ${Math.round(peakMB)} MB (cap ${MEMORY_CAP_MB} MB)`,
          );
          clearInterval(memoryGuard);
          await launched.close().catch(() => undefined);
        })
        .catch(() => undefined);
    }, 1000);
    const initial = await getDesktopState(window);
    await waitForThreadSettled(window, initial.selectedSessionId);
    const startup = {
      firstWindowMs,
      firstThreadSettledMs: Date.now() - launchStarted,
      workspaces: initial.workspaces.length,
      sessions: initial.workspaces.reduce((sum, workspace) => sum + workspace.sessions.length, 0),
      modelEntries: Object.values(initial.runtimeByWorkspace).reduce(
        (sum, runtime) => sum + (runtime?.models?.length ?? 0),
        0,
      ),
    };

    // React render counting needs the hook before React loads.
    await window.context().addInitScript(REACT_HOOK_SCRIPT);
    await window.reload();
    await window.waitForFunction(() => Boolean(globalThis.window.piApp), undefined, {
      timeout: 30_000,
    });
    await waitForThreadSettled(window, initial.selectedSessionId);
    await installMainInstrumentation(harness);
    const cdp = await window.context().newCDPSession(window);
    expect(
      await window.evaluate(() => Boolean((globalThis.window as RendererGlobal).__perfReact)),
    ).toBe(true);

    // Threads: the long one to type in, the largest one to open, others to run in the background.
    const state = await getDesktopState(window);
    const visible = new Map(
      state.workspaces.flatMap((workspace) =>
        workspace.sessions.map((session) => [
          session.id,
          {
            sessionRef: { workspaceId: workspace.id, sessionId: session.id },
            workspace: {
              workspaceId: workspace.id,
              path: workspace.path,
              displayName: workspace.name,
            },
            title: session.title,
          } satisfies LoadThread,
        ]),
      ),
    );
    const bySize = [...copy.sessions]
      .filter((session) => visible.has(session.sessionRef.sessionId))
      .sort((a, b) => b.bytes - a.bytes);
    const longThread = visible.get(
      process.env.PERF_THREAD ??
        bySize.find((session) => session.bytes < 100 * 1048576)!.sessionRef.sessionId,
    )!;
    const largest = bySize[0]!;
    const background = [...copy.sessions]
      .filter((session) => visible.has(session.sessionRef.sessionId))
      .filter(
        (session) =>
          session.sessionRef.sessionId !== longThread.sessionRef.sessionId &&
          session.sessionRef.sessionId !== largest.sessionRef.sessionId,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const loadThreads = [
      ...(OPEN_RUNNING ? [longThread] : []),
      ...background.slice(0, RUNNING).map((session) => visible.get(session.sessionRef.sessionId)!),
    ];
    const switchTargets = background
      .slice(RUNNING, RUNNING + 5)
      .map((session) => session.sessionRef);
    const setup = {
      source: { userData: SOURCE_USER_DATA, agent: SOURCE_AGENT },
      copy: copy.root,
      disabledPackages: DISABLED_PACKAGES,
      foreground: FOREGROUND,
      longThread: {
        title: longThread.title,
        mb: +(
          (bySize.find((s) => s.sessionRef.sessionId === longThread.sessionRef.sessionId)?.bytes ??
            0) / 1048576
        ).toFixed(1),
      },
      largestThread: { title: largest.title, mb: +(largest.bytes / 1048576).toFixed(1) },
      runningThreads: loadThreads.map((thread) => thread.title),
      load: "per running thread: text delta + session update every 50 ms, title request every 120 ms, tool call (~30 KB output) every 5 s",
    };

    await openThread(window, longThread.sessionRef);
    await startLoad(harness, loadThreads);
    await window.waitForTimeout(3000);

    const failures: Record<string, string> = {};
    const writeReport = async () => {
      const report = renderReport(results, startup, { ...setup, failures });
      await writeFile(join(OUT, "report.md"), report);
      await writeFile(
        join(OUT, "report.json"),
        JSON.stringify({ setup, startup, failures, results }, null, 2),
      );
    };
    // One failing scenario must not lose the others: record it, return to the long thread, go on.
    const scenario = async (name: string, body: () => Promise<Record<string, unknown>>) => {
      if (!scenarios(name)) return;
      try {
        results.push(await measure(name, harness!, window, cdp, body));
      } catch (error) {
        failures[name] = error instanceof Error ? error.message.split("\n")[0]! : String(error);
        await window.keyboard.press("Escape").catch(() => undefined);
        await openThread(window, longThread.sessionRef).catch(() => undefined);
      }
      await writeReport();
    };

    if (scenarios("idle")) {
      await scenario("idle", async () => {
        await window.waitForTimeout(15_000);
        return {};
      });
    }

    if (scenarios("typing")) {
      const composer = window.getByTestId("composer");
      await composer.click();
      await installKeyLatency(window);
      await scenario("typing", async () => {
        const text =
          "Please look at the session file and summarize what changed in the last run, then list the slowest steps. ";
        await window.keyboard.type(text + text.slice(0, 60), { delay: 70 });
        await window.waitForTimeout(500);
        return await readKeyLatency(window);
      });
      await composer.fill("");
    }

    if (scenarios("switch-threads")) {
      await scenario("switch-threads", async () => {
        const opens = [];
        for (const target of switchTargets) opens.push(await openThread(window, target));
        opens.push(await openThread(window, longThread.sessionRef));
        return { opens };
      });
    }

    if (scenarios("switch-phases")) {
      // Same switches as switch-threads, each split into phases, plus the session file size.
      const sizeOf = (id: string) =>
        +((copy.sessions.find((s) => s.sessionRef.sessionId === id)?.bytes ?? 0) / 1048576).toFixed(
          1,
        );
      await scenario("switch-phases", async () => {
        const opens = [];
        for (const target of [...switchTargets, longThread.sessionRef]) {
          opens.push({ mb: sizeOf(target.sessionId), ...(await openThreadPhased(window, target)) });
          await window.waitForTimeout(300);
        }
        return { opens };
      });
    }

    if (scenarios("scroll")) {
      await scenario("scroll", async () => {
        const box = (await window.getByTestId("timeline-pane").boundingBox())!;
        await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        for (let step = 0; step < 60; step += 1) {
          await window.mouse.wheel(0, -120);
          await window.waitForTimeout(40);
        }
        for (let step = 0; step < 60; step += 1) {
          await window.mouse.wheel(0, 120);
          await window.waitForTimeout(40);
        }
        return {};
      });
    }

    if (scenarios("model-picker")) {
      // The picker is disabled while a thread runs, so use an idle thread (background threads keep running).
      if (switchTargets[0]) await openThread(window, switchTargets[0]);
      await scenario("model-picker", async () => {
        const opens = [];
        for (let round = 0; round < 3; round += 1) {
          const started = Date.now();
          await window.locator(".composer__bar .model-selector__badge").first().click();
          const filter = window.getByPlaceholder("Filter models...");
          await expect(filter).toBeVisible();
          const shown = Date.now() - started;
          await filter.pressSequentially("claude", { delay: 70 });
          await window.waitForTimeout(300);
          await window.keyboard.press("Escape");
          opens.push(shown);
        }
        return { openMs: opens };
      });
      await openThread(window, longThread.sessionRef).catch(() => undefined);
    }

    if (scenarios("settings")) {
      await scenario("settings", async () => {
        const started = Date.now();
        await window.keyboard.press(desktopShortcut(","));
        await expect(window.getByTestId("settings-surface")).toBeVisible();
        const openMs = Date.now() - started;
        const modelsStarted = Date.now();
        await window.getByRole("button", { name: "Models", exact: true }).click();
        await expect(window.locator(".view-header__title")).toHaveText("Models");
        const modelsMs = Date.now() - modelsStarted;
        await window.waitForTimeout(1000);
        await window.getByRole("button", { name: "Back to app", exact: true }).click();
        await waitForThreadSettled(window, longThread.sessionRef.sessionId);
        return { openMs, modelsMs };
      });
    }

    if (scenarios("open-largest")) {
      await scenario("open-largest", async () => {
        const open = await openThreadPhased(window, largest.sessionRef);
        await window.waitForTimeout(300);
        // How many images the window actually asked for, versus how many the thread has.
        const imagesLoaded = await window.evaluate(() => ({
          inDom: document.querySelectorAll("img").length,
          byUrl: document.querySelectorAll('img[src^="pi-gui-image:"]').length,
          byData: document.querySelectorAll('img[src^="data:"]').length,
          requested: performance
            .getEntriesByType("resource")
            .filter((entry) => entry.name.startsWith("pi-gui-image:")).length,
        }));
        const again = await openThreadPhased(window, longThread.sessionRef);
        await window.waitForTimeout(300);
        // Second open: is anything cached after the first?
        const reopen = await openThreadPhased(window, largest.sessionRef);
        await window.waitForTimeout(300);
        const back = await openThreadPhased(window, longThread.sessionRef);
        return { largest: open, again, reopen, back, imagesLoaded };
      });
    }

    if (scenarios("memory-largest")) {
      // Main's memory after each step of opening the largest thread: what JS keeps after a
      // collection, total resident memory, and the macOS footprint broken down by memory type.
      const mainPid = await harness.electronApp.evaluate(() => process.pid);
      const sample = async (step: string) => {
        await window.waitForTimeout(1500);
        const js = await harness!.electronApp.evaluate(async () => {
          await (globalThis as MainGlobal).__perf!.post("HeapProfiler.collectGarbage");
          const usage = process.memoryUsage();
          const mb = (bytes: number) => Math.round(bytes / 1048576);
          return {
            heapUsedMB: mb(usage.heapUsed),
            externalMB: mb(usage.external),
            arrayBuffersMB: mb(usage.arrayBuffers),
            rssMB: mb(usage.rss),
          };
        });
        let footprint: Record<string, number> = {};
        try {
          const out = execFileSync("footprint", ["-p", String(mainPid)], { encoding: "utf8" });
          // Rows: "<dirty> <unit>  <clean> <unit>  <reclaimable> <unit>  <regions>  <category>".
          // Dirty memory is what counts toward the footprint.
          const toMB = (value: string, unit: string) =>
            Number(value) * ({ B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 }[unit] ?? 0);
          for (const line of out.split("\n")) {
            const match = line.match(
              /^\s*([\d.]+) (B|KB|MB|GB)\s+[\d.]+ (?:B|KB|MB|GB)\s+[\d.]+ (?:B|KB|MB|GB)\s+\d+\s+(.+)$/,
            );
            if (match) {
              const value = toMB(match[1]!, match[2]!);
              if (value >= 5) footprint[match[3]!.trim()] = Math.round(value);
              continue;
            }
            const total = line.match(/phys_footprint: ([\d.]+) (B|KB|MB|GB)/);
            if (total) footprint["phys_footprint"] = Math.round(toMB(total[1]!, total[2]!));
          }
        } catch (error) {
          footprint = { error: -1 };
          console.log("footprint failed", error instanceof Error ? error.message : error);
        }
        return { step, ...js, footprint };
      };
      await scenario("memory-largest", async () => {
        const steps = [await sample("start (long thread open)")];
        await openThreadPhased(window, largest.sessionRef);
        steps.push(await sample("largest opened"));
        await openThreadPhased(window, longThread.sessionRef);
        steps.push(await sample("back to long thread"));
        await openThreadPhased(window, largest.sessionRef);
        steps.push(await sample("largest reopened"));
        // Scroll up through the largest thread so more images load.
        const pane = window.getByTestId("timeline-pane");
        await pane.hover();
        for (let i = 0; i < 40; i += 1) {
          await window.mouse.wheel(0, -1500);
          await window.waitForTimeout(60);
        }
        const loaded = await window.evaluate(
          () =>
            performance
              .getEntriesByType("resource")
              .filter((entry) => entry.name.startsWith("pi-gui-image:")).length,
        );
        steps.push({ ...(await sample("scrolled up through largest")), loaded });
        await openThreadPhased(window, longThread.sessionRef);
        steps.push(await sample("back to long thread again"));
        return { steps };
      });
    }

    if (scenarios("second-window")) {
      await scenario("second-window", async () => {
        const started = Date.now();
        const next = harness!.electronApp.waitForEvent("window");
        await harness!.electronApp.evaluate(({ Menu }) => {
          Menu.getApplicationMenu()?.getMenuItemById("file.new-window")?.click();
        });
        const second = await next;
        await second.waitForFunction(() => Boolean(globalThis.window.piApp), undefined, {
          timeout: 30_000,
        });
        const openMs = Date.now() - started;
        await window.waitForTimeout(10_000);
        await second.close();
        return { openMs };
      });
    }

    await stopLoad(harness);
    await writeReport();
    console.log(`Report: ${join(OUT, "report.md")}`);
    if (Object.keys(failures).length) console.log(`Failed scenarios: ${JSON.stringify(failures)}`);
  } finally {
    clearInterval(memoryGuard);
    await harness?.close().catch(() => undefined);
    if (process.env.PERF_KEEP_PROFILE !== "1")
      await rm(copy.root, { recursive: true, force: true });
  }
});
