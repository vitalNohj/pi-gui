/**
 * Memory growth while opening threads, on a copy of the real profile (fork-only diagnostic).
 *
 * Opens the largest threads one at a time and records memory after each, with garbage collected
 * first so the numbers show what is kept, not garbage. Stops early if a process passes the limit
 * or a thread takes too long to open. Writes results after every thread.
 *
 *   PERF_REAL_PROFILE=1 PI_APP_TEST_MODE=background pnpm exec playwright test \
 *     -c apps/desktop/playwright.config.ts apps/desktop/tests/perf/memory-growth.spec.ts
 *
 * Options (env): PERF_OUT, PERF_THREADS (default 20), PERF_LIMIT_MB (default 3000),
 * PERF_SNAPSHOT=1 (main-process heap snapshot at the end), PERF_KEEP_PROFILE=1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { getDesktopState, launchDesktop, type DesktopHarness } from "../helpers/electron-app";

test.skip(process.env.PERF_REAL_PROFILE !== "1", "Set PERF_REAL_PROFILE=1 to run.");

const HOME = homedir();
const SOURCE_USER_DATA = join(HOME, "Library/Application Support/pi");
const SOURCE_AGENT = join(HOME, ".pi/agent");
const OUT =
  process.env.PERF_OUT ??
  join("/tmp/pi-gui-perf", `memory-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
const THREADS = Number(process.env.PERF_THREADS ?? 20);
const LIMIT_MB = Number(process.env.PERF_LIMIT_MB ?? 3000);
const OPEN_TIMEOUT_MS = 60_000;
const DISABLED_PACKAGES = ["pi-agentsview-sync", "pi-silent-update", "pi-keepwarm"];

type JsonObject = Record<string, unknown>;

interface CatalogSession {
  readonly sessionRef: { readonly workspaceId: string; readonly sessionId: string };
  readonly title: string;
  readonly sessionFilePath?: string;
}

async function rewriteJson(path: string, edit: (value: JsonObject) => JsonObject, from?: string, to?: string) {
  if (!existsSync(path)) return;
  let text = await readFile(path, "utf8");
  if (from && to) text = text.split(from).join(to);
  await writeFile(path, JSON.stringify(edit(JSON.parse(text) as JsonObject), null, 2));
}

async function copyProfile() {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-perf-profile-"));
  const userDataDir = join(root, "user-data");
  const agentDir = join(root, "agent");
  execFileSync("cp", ["-cR", SOURCE_USER_DATA, userDataDir]);
  execFileSync("cp", ["-cR", SOURCE_AGENT, agentDir]);
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"]) {
    await rm(join(userDataDir, name), { force: true });
  }
  for (const file of ["catalogs.json", "ui-state.json"]) {
    await rewriteJson(join(userDataDir, file), (value) => value, `${SOURCE_AGENT}/`, `${agentDir}/`);
  }
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
  const sessions = catalog.sessions.map((session) => {
    if (session.sessionFilePath && !session.sessionFilePath.startsWith(agentDir)) {
      throw new Error(`Session file outside the copy: ${session.sessionFilePath}`);
    }
    return {
      ...session,
      bytes:
        session.sessionFilePath && existsSync(session.sessionFilePath)
          ? statSync(session.sessionFilePath).size
          : 0,
    };
  });
  return { root, userDataDir, agentDir, sessions };
}

/** Physical footprint as Activity Monitor reports it, in MB, per process type. */
function footprints(mainPid: number): Record<string, number> {
  const children = execFileSync("pgrep", ["-P", String(mainPid)], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const result: Record<string, number> = {};
  for (const pid of [String(mainPid), ...children]) {
    let output = "";
    try {
      output = execFileSync("footprint", ["-p", pid], { encoding: "utf8" });
    } catch {
      continue;
    }
    const match = /^(.*?) \[\d+\]: .*Footprint: ([\d.]+) (KB|MB|GB)/m.exec(output);
    if (!match) continue;
    const name = match[1]!;
    const value = Number(match[2]) * (match[3] === "GB" ? 1024 : match[3] === "KB" ? 1 / 1024 : 1);
    const type = /Renderer/.test(name) ? "renderer" : /GPU/.test(name) ? "gpu" : /Helper/.test(name) ? "helper" : "main";
    result[type] = Math.round((result[type] ?? 0) + value);
  }
  return result;
}

interface MainGlobal {
  gc?: () => void;
}

async function mainHeap(harness: DesktopHarness) {
  return harness.electronApp.evaluate(() => {
    const v8 = process.getBuiltinModule("node:v8");
    (globalThis as MainGlobal).gc?.();
    const heap = v8.getHeapStatistics();
    const memory = process.memoryUsage();
    return {
      heapMB: Math.round(heap.used_heap_size / 1048576),
      externalMB: Math.round(memory.external / 1048576),
    };
  });
}

async function rendererHeap(cdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage");
  const usage = await cdp.send("Runtime.getHeapUsage");
  return Math.round(usage.usedSize / 1048576);
}

async function openThread(window: Page, ref: { workspaceId: string; sessionId: string }) {
  const started = Date.now();
  await window.evaluate((target) => globalThis.window.piApp!.selectSession(target), ref);
  await expect
    .poll(async () => (await getDesktopState(window)).selectedSessionId, { timeout: OPEN_TIMEOUT_MS })
    .toBe(ref.sessionId);
  await expect(window.getByTestId("transcript-skeleton")).toHaveCount(0, { timeout: OPEN_TIMEOUT_MS });
  return Date.now() - started;
}

test("memory while opening threads on a copy of the real profile", async () => {
  test.setTimeout(30 * 60_000);
  await mkdir(OUT, { recursive: true });
  const copy = await copyProfile();
  const rows: JsonObject[] = [];
  let stopReason = "finished";
  let harness: DesktopHarness | undefined;
  const write = async () => {
    const lines = [
      `# Memory while opening threads (${rows.length - 1} opened, ${stopReason})`,
      "",
      "Memory is the physical footprint (Activity Monitor), in MB, after garbage collection.",
      "",
      "| # | Thread file MB | Open ms | Main | Renderer | GPU | Total | Main JS heap | Renderer JS heap |",
      "|---|---|---|---|---|---|---|---|---|",
      ...rows.map(
        (row) =>
          `| ${String(row.index)} | ${String(row.fileMB)} | ${String(row.openMs)} | ${String(row.main)} | ${String(row.renderer)} | ${String(row.gpu)} | ${String(row.total)} | ${String(row.mainHeap)} | ${String(row.rendererHeap)} |`,
      ),
    ];
    await writeFile(join(OUT, "memory.md"), lines.join("\n") + "\n");
    await writeFile(join(OUT, "memory.json"), JSON.stringify({ stopReason, rows }, null, 2));
  };
  try {
    harness = await launchDesktop(copy.userDataDir, {
      agentDir: copy.agentDir,
      testMode: "background",
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
    const window = await harness.firstWindow();
    const mainPid = await harness.electronApp.evaluate(() => process.pid);
    const cdp = await window.context().newCDPSession(window);
    await expect(window.getByTestId("transcript-skeleton")).toHaveCount(0, { timeout: 120_000 });
    await window.waitForTimeout(5000);

    const state = await getDesktopState(window);
    const visible = new Set(state.workspaces.flatMap((workspace) => workspace.sessions.map((s) => s.id)));
    // Largest threads first, below 100 MB so one open doesn't dominate; the selected one is excluded.
    const targets = copy.sessions
      .filter((s) => visible.has(s.sessionRef.sessionId) && s.sessionRef.sessionId !== state.selectedSessionId)
      .filter((s) => s.bytes > 0 && s.bytes < 100 * 1048576)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, THREADS);

    const sample = async (index: number, fileMB: number, openMs: number) => {
      const heap = await mainHeap(harness!);
      const row = {
        index,
        fileMB,
        openMs,
        ...footprints(mainPid),
        mainHeap: heap.heapMB,
        mainExternal: heap.externalMB,
        rendererHeap: await rendererHeap(cdp),
      } as JsonObject & { main?: number; renderer?: number; gpu?: number };
      row.total = (row.main ?? 0) + (row.renderer ?? 0) + (row.gpu ?? 0);
      rows.push(row);
      await write();
      console.log(JSON.stringify(row));
      return row;
    };

    await sample(0, 0, 0);
    for (const [position, target] of targets.entries()) {
      let openMs: number;
      try {
        openMs = await openThread(window, target.sessionRef);
      } catch {
        stopReason = `thread ${position + 1} did not open within ${OPEN_TIMEOUT_MS / 1000} s`;
        break;
      }
      await window.waitForTimeout(1500);
      const row = await sample(position + 1, +(target.bytes / 1048576).toFixed(1), openMs);
      const largest = Math.max(row.main ?? 0, row.renderer ?? 0, row.gpu ?? 0);
      if (largest > LIMIT_MB) {
        stopReason = `a process passed ${LIMIT_MB} MB`;
        break;
      }
    }

    // Do the opened threads stay in memory? Go back to the first thread and wait.
    if (stopReason === "finished" && targets[0]) {
      await openThread(window, targets[0].sessionRef);
      await window.waitForTimeout(10_000);
      await sample(rows.length, 0, 0);
      rows.at(-1)!.note = "after returning to thread 1 and waiting 10 s";
    }

    if (process.env.PERF_SNAPSHOT === "1") {
      const file = join(OUT, "main.heapsnapshot");
      await harness.electronApp.evaluate((_, path) => {
        process.getBuiltinModule("node:v8").writeHeapSnapshot(path);
      }, file);
    }
    await write();
    console.log(`Report: ${join(OUT, "memory.md")} (${stopReason})`);
  } finally {
    await harness?.close().catch(() => undefined);
    if (process.env.PERF_KEEP_PROFILE !== "1") await rm(copy.root, { recursive: true, force: true });
  }
});
