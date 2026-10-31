/**
 * Opt-in: per-process memory of an idle app with one open thread, sampled without profilers.
 *
 *   PERF_IDLE_MEMORY=1 PERF_OUT=/tmp/idle PI_APP_TEST_MODE=background pnpm exec playwright test \
 *     -c apps/desktop/playwright.config.ts apps/desktop/tests/perf/idle-memory.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test.skip(process.env.PERF_IDLE_MEMORY !== "1", "Set PERF_IDLE_MEMORY=1 to measure idle memory.");

test("idle per-process memory", async () => {
  test.setTimeout(120_000);
  const out = process.env.PERF_OUT ?? join(process.cwd(), "idle-memory");
  await mkdir(out, { recursive: true });
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("idle-memory")],
    testMode: "background",
  });
  try {
    const page = await harness.firstWindow();
    await createNamedThread(page, "Idle memory");
    const samples: { atMs: number; processes: Record<string, number> }[] = [];
    for (let index = 0; index < 6; index += 1) {
      await page.waitForTimeout(2_000);
      samples.push({
        atMs: (index + 1) * 2_000,
        processes: await harness.electronApp.evaluate(({ app }) => {
          const totals: Record<string, number> = {};
          for (const metric of app.getAppMetrics()) {
            const name = metric.type + (metric.name ? `:${metric.name}` : "");
            totals[name] = (totals[name] ?? 0) + Math.round(metric.memory.workingSetSize / 1024);
          }
          return totals;
        }),
      });
    }
    await writeFile(join(out, "idle-memory.json"), JSON.stringify(samples, null, 2));
  } finally {
    await harness.close();
  }
});
