/**
 * Performance survey on a copy of a real profile (fork-only diagnostic, not a regression test).
 *
 * Copies the real pi-gui profile and pi agent folder (APFS clones), switches off side effects in
 * the copy, simulates running threads with the app's test hooks (no model calls), runs user
 * scenarios and writes a ranked report.
 *
 *   pnpm --filter @pi-gui/desktop build
 *   PERF_REAL_PROFILE=1 PI_APP_TEST_MODE=background pnpm exec playwright test \
 *     -c apps/desktop/playwright.config.ts apps/desktop/tests/perf/typing-tool-hitches.spec.ts
 *
 * Options (env): PERF_OUT, PERF_RUNNING (background running threads, default 2),
 * PERF_OPEN_RUNNING (open thread also running, default 1), PERF_FOREGROUND=1 (show window),
 * PERF_SCENARIOS (comma list), PERF_THREAD (sessionId to type in). Profile copies are retained.
 * PERF_SDK=1 executes real built-in tools against a scripted localhost provider (no paid API).
 * PERF_ACP=1 includes an isolated copy of the installed compression extension and its config.
 * PERF_FRESH_THREAD=1 compares the same tool sequence in an empty thread.
 * PERF_PROBE=1 adds sampled data-flow instrumentation; use its CPU times as diagnostic only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
const REAL_SDK = process.env.PERF_SDK === "1";
const WITH_ACP = process.env.PERF_ACP === "1";
const SDK_TOOL = process.env.PERF_SDK_TOOL ?? "bash";
const SDK_TURNS = Number(process.env.PERF_SDK_TURNS ?? 8);
// CPU profilers add their own memory and time. Turn them off to measure memory and latency only.
const NO_PROFILER = process.env.PERF_NO_PROFILER === "1";

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

/** Loopback-only OpenAI fixture: drains but NEVER logs/parses private prompt bodies. */
async function startScriptedProvider() {
  const stats = { requests: [] as { bytes: number; receivedAt: number }[], finished: false };
  const server = createServer((request, response) => {
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024 * 1024)
        request.destroy(new Error("Diagnostic request exceeds 256 MiB cap"));
    });
    request.on("error", () => response.destroy());
    request.on("end", () => {
      const round = stats.requests.length;
      stats.requests.push({ bytes, receivedAt: Date.now() });
      const tool = round < SDK_TURNS;
      const id = `chatcmpl-local-perf-${round}`;
      const chunk = (delta: object, finish: string | null = null) => {
        response.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "scripted",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      };
      // Delay on the server, not Electron's event loop, to spread tool completions across typing.
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        chunk({ role: "assistant" });
        if (tool) {
          // Only these fixed harmless operations can execute. No user/repo command is reused.
          const args =
            SDK_TOOL === "read"
              ? { path: process.env.PERF_IMAGE_PATH! }
              : {
                  command: `cd ${JSON.stringify(OUT)} && /usr/bin/true && /bin/sleep 0.5 && /usr/bin/python3 -c 'print("p" * ${TOOL_BYTES})'`,
                  timeout: 5,
                };
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `perf-builtin-${round}`,
                type: "function",
                function: { name: SDK_TOOL, arguments: JSON.stringify(args) },
              },
            ],
          });
          chunk({}, "tool_calls");
        } else {
          chunk({ content: "CONTROLLED LOCAL TOOL RUN FINISHED" });
          chunk({}, "stop");
          stats.finished = true;
        }
        response.end("data: [DONE]\n\n");
      }, 600);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback provider did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    stats,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function copyProfile(localBaseUrl?: string): Promise<ProfileCopy> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-perf-profile-"));
  const userDataDir = join(root, "user-data");
  const agentDir = join(root, "agent");
  clone(SOURCE_USER_DATA, userDataDir);
  // Preserve real session scale without credentials, installed extensions or sync agents.
  await mkdir(agentDir);
  clone(join(SOURCE_AGENT, "sessions"), join(agentDir, "sessions"));
  // Copied leases still name live PIDs. Remove ONLY the diagnostic copy's lease files.
  execFileSync("find", [
    join(agentDir, "sessions"),
    "-type",
    "f",
    "-name",
    "*.jsonl.lease*",
    "-delete",
  ]);
  clone(join(SOURCE_AGENT, "settings.json"), join(agentDir, "settings.json"));
  if (WITH_ACP) {
    clone(
      process.env.PERF_ACP_PACKAGE_DIR ?? join(SOURCE_AGENT, "npm/node_modules/billion-context-pi"),
      join(root, "billion-context-pi"),
    );
    await mkdir(join(root, ".pi"));
    const acpConfig = process.env.PERF_ACP_CONFIG_PATH ?? join(HOME, ".pi/acp.json");
    if (existsSync(acpConfig)) clone(acpConfig, join(root, ".pi/acp.json"));
  }
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: localBaseUrl
        ? {
            "typing-perf-local": {
              baseUrl: localBaseUrl,
              api: "openai-completions",
              apiKey: "LOCAL_DIAGNOSTIC_NOT_A_SECRET",
              models: [
                {
                  id: "scripted",
                  name: "Controlled localhost performance fixture",
                  reasoning: false,
                  input: ["text", "image"],
                  contextWindow: 10000000,
                  maxTokens: 4096,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          }
        : {},
    }),
  );
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
  // Never retain runnable tasks in a diagnostic copy. An empty valid schedule is safest.
  await rewriteJson(join(userDataDir, "scheduled-tasks.json"), (value) => ({
    ...value,
    tasks: [],
  }));
  if (localBaseUrl) {
    await rewriteJson(join(userDataDir, "ui-state.json"), (value) => ({
      ...value,
      modelSettingsScopeMode: "app-global",
      appGlobalModelSettings: {
        enabledModelPatterns: ["typing-perf-local/scripted"],
        defaultProvider: "typing-perf-local",
        defaultModelId: "scripted",
        defaultThinkingLevel: "off",
      },
    }));
  }
  await rewriteJson(join(agentDir, "settings.json"), (value) => ({
    ...value,
    packages: [],
    extensions: WITH_ACP ? [join(root, "billion-context-pi/dist/index.js")] : [],
    skills: [],
    ...(localBaseUrl
      ? {
          defaultProvider: "typing-perf-local",
          defaultModel: "scripted",
          defaultThinkingLevel: "off",
          enabledModels: ["typing-perf-local/scripted"],
          defaultTools: ["bash", "read"],
          cacheWarming: "off",
          compaction: { enabled: false },
          retry: { enabled: false, provider: { maxRetries: 0 } },
          shellPath: "/bin/bash",
          shellCommandPrefix: undefined,
          httpProxy: undefined,
          defaultProjectTrust: "never",
        }
      : {}),
  }));
  // A registered workspace has an auto-discovered project extension: never load it.
  const inertWorkspace = join(root, "inert-firstmate");
  await mkdir(inertWorkspace);
  await rewriteJson(join(userDataDir, "catalogs.json"), (value) => ({
    ...value,
    workspaces: (value.workspaces as JsonObject[]).map((workspace) =>
      workspace.path === join(HOME, "firstmate")
        ? { ...workspace, path: inertWorkspace }
        : workspace,
    ),
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
  errors?: number;
  tools?: number;
  commands?: number;
  payloadBytes?: number;
  maxEventLoopGapMs?: number;
}

const WORKLOAD = process.env.PERF_LOAD ?? "mixed";
const TOOL_BYTES = Number(process.env.PERF_TOOL_BYTES ?? 30000);
const TOOL_INTERVAL_MS = Number(process.env.PERF_TOOL_INTERVAL_MS ?? 2000);
const IMAGE_BASE64 = process.env.PERF_IMAGE_PATH
  ? readFileSync(process.env.PERF_IMAGE_PATH).toString("base64")
  : null;

/** State the survey keeps in the main process between evaluate calls. */
type MainGlobal = typeof globalThis & {
  __perf?: {
    sends: Record<string, SendStats>;
    active: boolean;
    gaps: { startedAt: number; delayMs: number }[];
    post: (method: string, params?: object) => Promise<object | undefined>;
  };
  __perfLoad?: { stats: LoadStats; stop(): void };
  __perfProbe?: { active: boolean; reset(): void; read(): unknown };
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
      active: false,
      gaps: [] as { startedAt: number; delayMs: number }[],
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
    let previousBeat = performance.now();
    setInterval(() => {
      const now = performance.now();
      const delayMs = now - previousBeat - 20;
      if (perf.active && delayMs >= 50) {
        perf.gaps.push({ startedAt: Date.now() - delayMs, delayMs });
      }
      previousBeat = now;
    }, 20).unref();
    if (process.env.PERF_PROBE === "1") {
      const crypto = process.getBuiltinModule("node:crypto");
      type Counter = {
        count: number;
        ms: number;
        sampled: number;
        bytes: number;
        maxBytes: number;
        unchangedSamples: number;
        fieldBytes: Record<string, number>;
      };
      let clones: Record<string, Counter> = {};
      let fields: Record<string, { sampled: number; bytes: number; changed: number }> = {};
      let lastSignatures: Record<string, string> = {};
      const probe = {
        active: false,
        reset() {
          clones = {};
          fields = {};
          lastSignatures = {};
        },
        read() {
          return { clones, fields };
        },
      };
      const signature = (buffer: Buffer) =>
        crypto.createHash("sha256").update(buffer).digest("hex");
      const originalClone = globalThis.structuredClone;
      globalThis.structuredClone = function <T>(value: T, options?: StructuredSerializeOptions): T {
        if (!probe.active) return originalClone(value, options);
        const caller = new Error().stack?.split("\n").slice(2, 5).join(" ← ") ?? "unknown";
        const entry = (clones[caller] ??= {
          count: 0,
          ms: 0,
          sampled: 0,
          bytes: 0,
          maxBytes: 0,
          unchangedSamples: 0,
          fieldBytes: {},
        });
        const started = performance.now();
        const result = originalClone(value, options);
        entry.ms += performance.now() - started;
        entry.count += 1;
        if (entry.count % 30 === 1) {
          const encoded = v8.serialize(value);
          entry.sampled += 1;
          entry.bytes += encoded.length;
          entry.maxBytes = Math.max(entry.maxBytes, encoded.length);
          const nextSignature = signature(encoded);
          if (lastSignatures[caller] === nextSignature) entry.unchangedSamples += 1;
          lastSignatures[caller] = nextSignature;
          if (value && typeof value === "object" && !Array.isArray(value)) {
            for (const [key, field] of Object.entries(value)) {
              entry.fieldBytes[key] = (entry.fieldBytes[key] ?? 0) + v8.serialize(field).length;
            }
          }
        }
        return result;
      };
      for (const window of BrowserWindow.getAllWindows()) {
        const wc = window.webContents;
        const send = wc.send.bind(wc);
        let count = 0;
        wc.send = (channel: string, ...args: unknown[]) => {
          if (probe.active && channel === "pi-gui:state-changed" && ++count % 10 === 1) {
            for (const [key, value] of Object.entries(args[0] as JsonObject)) {
              const encoded = v8.serialize(value);
              const entry = (fields[key] ??= { sampled: 0, bytes: 0, changed: 0 });
              entry.sampled += 1;
              entry.bytes += encoded.length;
              const nextSignature = signature(encoded);
              if (key in lastSignatures && lastSignatures[key] !== nextSignature)
                entry.changed += 1;
              lastSignatures[key] = nextSignature;
            }
          }
          send(channel, ...args);
        };
      }
      g.__perfProbe = probe;
    }
  });
}

async function startMain(harness: DesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(async ({ app }, noProfiler) => {
    const perf = (globalThis as MainGlobal).__perf!;
    perf.sends = {};
    perf.gaps = [];
    perf.active = true;
    const probe = (globalThis as MainGlobal).__perfProbe;
    probe?.reset();
    if (probe) probe.active = true;
    app.getAppMetrics(); // resets percentCPUUsage
    if (noProfiler) return;
    const post = perf.post;
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 500 });
    await post("Profiler.start");
  }, NO_PROFILER);
}

async function stopMain(harness: DesktopHarness) {
  return harness.electronApp.evaluate(async ({ app }, noProfiler) => {
    const perf = (globalThis as MainGlobal).__perf!;
    const { profile } = noProfiler
      ? { profile: { nodes: [], startTime: 0, endTime: 0, samples: [], timeDeltas: [] } }
      : ((await perf.post("Profiler.stop")) as { profile: unknown });
    perf.active = false;
    const processes = app.getAppMetrics().map((metric) => ({
      type: metric.type,
      name: metric.name ?? metric.serviceName ?? "",
      cpuPercent: metric.cpu.percentCPUUsage,
      memoryMB: Math.round(metric.memory.workingSetSize / 1024),
    }));
    const probe = (globalThis as MainGlobal).__perfProbe;
    if (probe) probe.active = false;
    return {
      profile,
      sends: perf.sends,
      processes,
      dataFlow: probe?.read() ?? null,
      gaps: perf.gaps,
    };
  }, NO_PROFILER);
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
  if (NO_PROFILER) return;
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  await cdp.send("Profiler.start");
}

async function stopRenderer(window: Page, cdp: CDPSession) {
  const { profile } = NO_PROFILER
    ? { profile: { nodes: [], startTime: 0, endTime: 0, samples: [], timeDeltas: [] } }
    : await cdp.send("Profiler.stop");
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
      const stats = {
        emitted: 0,
        dropped: 0,
        errors: 0,
        tools: 0,
        commands: 0,
        payloadBytes: 0,
        maxEventLoopGapMs: 0,
      };
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
          .catch(() => {
            stats.errors += 1;
          })
          .finally(() => (pending -= 1));
      };
      const timers: ReturnType<typeof setInterval>[] = [];
      const filler = "src/example/file.ts:42: const value = compute(input, options); // match\n";
      const toolOutput = filler.repeat(Math.ceil(input.toolBytes / filler.length));
      let lastTick = performance.now();
      timers.push(
        setInterval(() => {
          const now = performance.now();
          stats.maxEventLoopGapMs = Math.max(stats.maxEventLoopGapMs, now - lastTick);
          lastTick = now;
        }, 20),
      );
      if (input.workload === "none") {
        g.__perfLoad = {
          stats,
          stop() {
            timers.forEach(clearInterval);
          },
        };
        return;
      }
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
        if (input.workload === "stream") return;
        // Controlled tool output; the spawn case runs only a no-op in the isolated main.
        let call = 0;
        timers.push(
          setInterval(() => {
            call += 1;
            const callId = `perf-call-${threadIndex}-${call}-${Date.now()}`;
            stats.tools += 1;
            if (input.workload === "spawn") {
              process
                .getBuiltinModule("node:child_process")
                .execFile("/usr/bin/true", [], { cwd: input.safeCwd }, () => {
                  stats.commands += 1;
                });
            }
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
                output: {
                  content: input.imageBase64
                    ? [
                        { type: "image", data: input.imageBase64, mimeType: "image/png" },
                        { type: "text", text: "Controlled screenshot result" },
                      ]
                    : [{ type: "text", text: toolOutput }],
                },
              });
              stats.payloadBytes += input.imageBase64?.length ?? toolOutput.length;
              updated("tool finished");
            }, 100);
          }, input.toolIntervalMs),
        );
      });
      g.__perfLoad = {
        stats,
        stop() {
          for (const timer of timers) clearInterval(timer);
        },
      };
    },
    {
      threads,
      workload: WORKLOAD,
      toolBytes: TOOL_BYTES,
      toolIntervalMs: TOOL_INTERVAL_MS,
      imageBase64: IMAGE_BASE64,
      safeCwd: OUT,
    },
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

/** Profile the separately scheduled runtime too; older before builds have no runtime hook. */
async function startAgentRuntimeProfile(harness: DesktopHarness) {
  const info = await harness.electronApp.evaluate(() =>
    (
      globalThis as {
        __PI_APP_TEST_HOOKS?: { agentRuntimeInfo?: () => { pid?: number; inspectorUrl?: string } };
      }
    ).__PI_APP_TEST_HOOKS?.agentRuntimeInfo?.(),
  );
  if (!info || NO_PROFILER) return null;
  if (!info.inspectorUrl) throw new Error("Runtime inspector was not enabled for this capture");
  const socket = new WebSocket(info.inspectorUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Runtime inspector connection failed")),
      { once: true },
    );
  });
  let id = 0;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  const close = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Runtime inspector closed"));
    }
    pending.clear();
  };
  socket.addEventListener("close", close);
  socket.addEventListener("message", (event) => {
    const reply = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (!reply.id) return;
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    if (reply.error) request.reject(new Error(reply.error.message));
    else request.resolve(reply.result);
  });
  const post = (method: string, params: object = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Runtime inspector timed out: ${method}`));
      }, 20_000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  try {
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 500 });
    await post("Profiler.start");
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    pid: info.pid,
    async stop() {
      try {
        return ((await post("Profiler.stop")) as { profile: CpuProfile }).profile;
      } finally {
        socket.close();
      }
    },
  };
}

interface ScenarioResult {
  readonly name: string;
  readonly seconds: number;
  readonly notes: Record<string, unknown>;
  readonly main: ReturnType<typeof analyzeProfile>;
  readonly renderer: ReturnType<typeof analyzeProfile>;
  readonly runtime?: ReturnType<typeof analyzeProfile>;
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
  const runtimeProfiler = await startAgentRuntimeProfile(harness);
  await startRenderer(window, cdp);
  const started = Date.now();
  // A failed scenario must still retain both CPU profiles and the timing evidence.
  const notes = await body().catch((error: unknown) => ({
    measurementError: error instanceof Error ? (error.stack ?? error.message) : String(error),
  }));
  const seconds = (Date.now() - started) / 1000;
  const renderer = await stopRenderer(window, cdp);
  const main = await stopMain(harness);
  const runtimeProfile = await runtimeProfiler?.stop();
  if (runtimeProfile)
    await writeFile(join(OUT, `${name}.runtime.cpuprofile`), JSON.stringify(runtimeProfile));
  const load = await harness.electronApp.evaluate(() => {
    const stats = (globalThis as MainGlobal).__perfLoad?.stats;
    return stats ? { ...stats } : null;
  });
  await writeFile(join(OUT, `${name}.main.cpuprofile`), JSON.stringify(main.profile));
  await writeFile(join(OUT, `${name}.renderer.cpuprofile`), JSON.stringify(renderer.profile));
  if (main.dataFlow)
    await writeFile(join(OUT, `${name}.dataflow.json`), JSON.stringify(main.dataFlow, null, 2));
  return {
    name,
    seconds,
    notes: {
      ...notes,
      mainEventLoop: {
        // Profiler.start itself can synchronously stall main; exclude setup/teardown.
        scope: "scenario body only; profiler startup and teardown excluded",
        gaps: main.gaps.filter(
          (gap) => gap.startedAt >= started && gap.startedAt < started + seconds * 1000,
        ),
        maxDelayMs: Math.max(
          0,
          ...main.gaps
            .filter((gap) => gap.startedAt >= started && gap.startedAt < started + seconds * 1000)
            .map((gap) => gap.delayMs),
        ),
      },
      instrumentationMainEventLoop: {
        gaps: main.gaps.filter(
          (gap) => gap.startedAt < started || gap.startedAt >= started + seconds * 1000,
        ),
      },
    },
    main: analyzeProfile(main.profile as CpuProfile),
    renderer: analyzeProfile(renderer.profile as unknown as CpuProfile),
    ...(runtimeProfile ? { runtime: analyzeProfile(runtimeProfile) } : {}),
    sends: main.sends,
    processes: main.processes,
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

async function openThread(window: Page, ref: { workspaceId: string; sessionId: string }) {
  // In-page phase marks, measured from the click: row highlighted, skeleton shown, content shown,
  // timeline settled, plus long tasks over the switch. Polling over IPC would add its own delay.
  await window.evaluate((sessionId) => {
    const g = globalThis as typeof globalThis & { __perfOpen?: Record<string, unknown> };
    const marks: Record<string, number> = {};
    const longTasks: number[] = [];
    // Measured from the real pointer press, so harness round trips before the click don't count.
    let t0 = performance.now();
    let pressed = false;
    const onPress = () => {
      if (pressed) return;
      pressed = true;
      t0 = performance.now();
    };
    document.addEventListener("pointerdown", onPress, { capture: true });
    const check = () => {
      if (!pressed) return;
      const now = performance.now() - t0;
      const row = document.querySelector(`[data-session-id="${sessionId}"]`);
      if (marks.highlighted === undefined && row?.classList.contains("session-row--active"))
        marks.highlighted = now;
      const skeleton = document.querySelector('[data-testid="transcript-skeleton"]');
      if (skeleton && marks.skeleton === undefined) marks.skeleton = now;
      const pane = document.querySelector('[data-testid="timeline-pane"]');
      // The highlight and the skeleton land in the same commit, so this waits for the transcript.
      if (!skeleton && pane && marks.content === undefined && marks.highlighted !== undefined) {
        marks.content = now;
        // The next frame after the content commit: roughly when the person sees it.
        requestAnimationFrame(() =>
          setTimeout(() => {
            marks.painted = performance.now() - t0;
          }),
        );
      }
      if (
        pane?.getAttribute("data-layout") === "settled" &&
        marks.content !== undefined &&
        marks.settled === undefined
      )
        marks.settled = now;
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "data-layout"],
    });
    const longObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
    });
    longObserver.observe({ type: "longtask" });
    g.__perfOpen = {
      marks,
      longTasks,
      start: onPress,
      stop: () => {
        observer.disconnect();
        longObserver.disconnect();
        document.removeEventListener("pointerdown", onPress, { capture: true });
      },
    };
  }, ref.sessionId);
  const started = Date.now();
  const row = window.locator(`[data-session-id="${ref.sessionId}"] .session-row__select`);
  const viaSidebar = (await row.count()) > 0 && (await row.first().isVisible());
  if (viaSidebar) {
    await row.first().click();
  } else {
    await window.evaluate((target) => {
      (
        globalThis as typeof globalThis & { __perfOpen?: { start: () => void } }
      ).__perfOpen!.start();
      return globalThis.window.piApp!.selectSession(target);
    }, ref);
  }
  // Wait in the page, not by pulling app state over IPC: each pull copies the whole state and
  // would slow the switch being measured.
  await window.waitForFunction(
    () => {
      const g = globalThis as typeof globalThis & {
        __perfOpen?: { marks: Record<string, number> };
      };
      return g.__perfOpen?.marks.painted !== undefined && g.__perfOpen.marks.settled !== undefined;
    },
    undefined,
    { timeout: 120_000, polling: 50 },
  );
  const total = Date.now() - started;
  const inPage = await window.evaluate(() => {
    const g = globalThis as typeof globalThis & {
      __perfOpen?: { marks: Record<string, number>; longTasks: number[]; stop: () => void };
    };
    const open = g.__perfOpen!;
    open.stop();
    const marks = Object.fromEntries(
      Object.entries(open.marks).map(([key, value]) => [key, Math.round(value)]),
    );
    return { marks, longTasks: open.longTasks };
  });
  await waitForThreadSettled(window, ref.sessionId);
  return { ms: total, viaSidebar, ...inPage };
}

/** Per keystroke: wait before the handler ran, handler time, and time until the app was idle. */
async function installKeyLatency(window: Page) {
  await window.evaluate(() => {
    const g = globalThis.window as RendererGlobal;
    g.__perfKeys?.remove();
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
        channel.port1.close();
        channel.port2.close();
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
      ...(result.runtime ? [["Agent runtime", result.runtime] as const] : []),
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
  const scripted = REAL_SDK ? await startScriptedProvider() : undefined;
  const copy = await copyProfile(scripted?.baseUrl);
  const scenarios = (name: string) => !ONLY || ONLY.includes(name);
  const results: ScenarioResult[] = [];
  let harness: DesktopHarness | undefined;
  try {
    const launchStarted = Date.now();
    harness = await launchDesktop(copy.userDataDir, {
      agentDir: copy.agentDir,
      testMode: FOREGROUND ? "foreground" : "background",
      scrubProviderEnv: true,
      envOverrides: {
        HTTP_PROXY: undefined,
        HTTPS_PROXY: undefined,
        ALL_PROXY: undefined,
        http_proxy: undefined,
        https_proxy: undefined,
        all_proxy: undefined,
        NO_PROXY: "127.0.0.1,localhost",
        ...(scripted ? { HOME: copy.root } : {}),
        ACP_LOG_FILE: join(OUT, "acp.log"),
        ACP_AUTO_UPDATE: "0",
        ACP_DEBUG: "0",
        PI_APP_TEST_RUNTIME_INSPECTOR: NO_PROFILER ? undefined : "1",
        BILLION_CONTEXT_PROXY: undefined,
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
    const doctor = await harness.electronApp.evaluate(({ app, BrowserWindow }) => ({
      pid: process.pid,
      appPath: app.getAppPath(),
      userData: app.getPath("userData"),
      backgroundThrottling: BrowserWindow.getAllWindows()[0]?.webContents.getBackgroundThrottling(),
      agentDir: process.env.PI_CODING_AGENT_DIR,
    }));
    expect(doctor.userData).toBe(copy.userDataDir);
    expect(doctor.backgroundThrottling).toBe(false);
    await writeFile(join(OUT, "doctor.json"), JSON.stringify(doctor, null, 2));
    const firstWindowMs = Date.now() - launchStarted;
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
    let longThread = visible.get(
      process.env.PERF_THREAD ??
        bySize.find((session) => session.bytes < 100 * 1048576)!.sessionRef.sessionId,
    )!;
    if (process.env.PERF_FRESH_THREAD === "1") {
      const workspaceId = longThread.sessionRef.workspaceId;
      const title = "Controlled empty-thread comparison";
      const created = await window.evaluate(
        async ({ workspaceId, title }) => {
          const next = await globalThis.window.piApp.createSession({ workspaceId, title });
          return next.workspaces
            .find((workspace) => workspace.id === workspaceId)!
            .sessions.find((entry) => entry.title === title)!;
        },
        { workspaceId, title },
      );
      longThread = { ...longThread, title, sessionRef: { workspaceId, sessionId: created.id } };
    }
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
      disabledPackages: WITH_ACP
        ? "All except the installed ACP context manager, copied with its config and sidecar; credentials removed"
        : "ALL; no installed extensions or real credentials; project extension isolated",
      realSdk: scripted
        ? { baseUrl: scripted.baseUrl, tool: SDK_TOOL, turns: SDK_TURNS, acp: WITH_ACP }
        : false,
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
      load: {
        workload: WORKLOAD,
        toolBytes: TOOL_BYTES,
        intervalMs: TOOL_INTERVAL_MS,
        imageBytes: IMAGE_BASE64?.length ?? 0,
        description:
          "20 Hz stream + 8.3 Hz titles per thread; controlled tool results; spawn is /usr/bin/true",
      },
    };

    await openThread(window, longThread.sessionRef);
    if (scripted) {
      await window.evaluate(async ({ workspaceId, sessionId }) => {
        await globalThis.window.piApp.setSessionModel(
          workspaceId,
          sessionId,
          "typing-perf-local",
          "scripted",
        );
        await globalThis.window.piApp.setSessionThinkingLevel(workspaceId, sessionId, "off");
      }, longThread.sessionRef);
    }
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
        const result = await measure(name, harness!, window, cdp, body);
        results.push(result);
        if (result.notes.measurementError) failures[name] = String(result.notes.measurementError);
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
      await scenario("typing", async () => {
        let runStartDispatchMs: number | undefined;
        if (scripted) {
          await composer.fill("Execute the controlled local diagnostic operations.");
          const before = performance.now();
          await composer.press("Enter");
          runStartDispatchMs = performance.now() - before;
          await expect(composer).toHaveValue("");
        }
        await installKeyLatency(window);
        const text =
          "Please look at the session file and summarize what changed in the last run, then list the slowest steps. ";
        const inputText = text + text.slice(0, 60);
        const dispatchMs: number[] = [];
        const slowDispatches: { startedAt: number; ms: number }[] = [];
        for (const char of inputText) {
          const startedAt = Date.now();
          const before = performance.now();
          await window.keyboard.type(char);
          const ms = performance.now() - before;
          dispatchMs.push(ms);
          if (ms >= 50) slowDispatches.push({ startedAt, ms });
          await window.waitForTimeout(70);
        }
        await window.waitForTimeout(500);
        if (scripted) {
          await expect.poll(() => scripted.stats.finished, { timeout: 60_000 }).toBe(true);
          expect(scripted.stats.requests.length).toBe(SDK_TURNS + 1);
        }
        const keyed = await readKeyLatency(window);
        expect(keyed.keys).toBe(inputText.length);
        expect(await composer.inputValue()).toBe(inputText);
        const sorted = dispatchMs.sort((a, b) => a - b);
        return {
          ...keyed,
          slowDispatches,
          ...(scripted ? { runStartDispatchMs, realSdk: scripted.stats } : {}),
          dispatchRoundTripMs: {
            p50: sorted[Math.floor(sorted.length * 0.5)],
            p95: sorted[Math.floor(sorted.length * 0.95)],
            max: sorted.at(-1),
          },
        };
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

    if (scenarios("switch-loaded")) {
      // Back and forth between threads that stay loaded (the recent few), as in everyday use.
      await scenario("switch-loaded", async () => {
        const pair = [switchTargets[0]!, longThread.sessionRef];
        for (const target of pair) await openThread(window, target);
        await window.waitForTimeout(1000);
        const opens = [];
        for (let round = 0; round < 4; round += 1) {
          for (const target of pair) {
            opens.push({ sessionId: target.sessionId, ...(await openThread(window, target)) });
            await window.waitForTimeout(500);
          }
        }
        return { opens };
      });
    }

    if (scenarios("window-return")) {
      // Returning to the window reconciles the selected workspace against its session files.
      const focus = () =>
        harness!.electronApp.evaluate(({ BrowserWindow }) => {
          const [first] = BrowserWindow.getAllWindows();
          first?.emit("blur");
          first?.emit("focus");
        });
      await scenario("window-return", async () => {
        await installKeyLatency(window);
        const composer = window.getByTestId("composer");
        await composer.click();
        const returns: number[] = [];
        for (let round = 0; round < 3; round += 1) {
          const started = Date.now();
          await focus();
          // Type while the reconcile runs, as a person does after switching back.
          await composer.pressSequentially("back again ", { delay: 70 });
          returns.push(Date.now() - started);
          await window.waitForTimeout(4000);
        }
        const keyed = await readKeyLatency(window);
        await composer.fill("");
        return { returns, ...keyed };
      });
    }

    if (scenarios("reopen-released")) {
      // Threads beyond the recent few are released; reopening one reloads it from its file.
      const large = bySize
        .filter((session) => session.sessionRef.sessionId !== longThread.sessionRef.sessionId)
        .slice(0, 3)
        .map((session) => session.sessionRef);
      await scenario("reopen-released", async () => {
        const opens = [];
        for (const target of large) opens.push({ first: await openThread(window, target) });
        // Visit other threads so the large ones fall out of the recent set and are released.
        for (const target of switchTargets.slice(0, 4)) await openThread(window, target);
        await window.waitForTimeout(2000);
        const loaded = await harness!.electronApp.evaluate(() =>
          (
            globalThis as typeof globalThis & {
              __PI_APP_TEST_HOOKS?: { loadedTranscriptSessionIds?: () => string[] };
            }
          ).__PI_APP_TEST_HOOKS?.loadedTranscriptSessionIds?.(),
        );
        for (const [index, target] of large.entries()) {
          opens[index] = { ...opens[index]!, again: await openThread(window, target) };
        }
        await openThread(window, longThread.sessionRef);
        return { opens, loadedBeforeReopen: loaded?.length };
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
        const open = await openThread(window, largest.sessionRef);
        const back = await openThread(window, longThread.sessionRef);
        return { largest: open, back };
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
    expect(Object.keys(failures)).toEqual([]);
    for (const result of results) expect(result.load?.errors ?? 0).toBe(0);
  } finally {
    await harness?.close().catch(() => undefined);
    if (scripted)
      await writeFile(join(OUT, "provider-stats.json"), JSON.stringify(scripted.stats, null, 2));
    await scripted?.close();
    // Preserve captures and profile copies: existing artifacts must not be deleted.
    console.log(`Isolated profile retained: ${copy.root}`);
  }
});
