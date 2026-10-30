import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  writeProjectExtension,
} from "../helpers/electron-app";
import { startHangingOpenAiServer } from "../helpers/hanging-openai-server";

test("typing and main IPC complete while an extension is synchronously blocked in its own process", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("agent-runtime-isolation");
  const started = join(workspacePath, "started");
  const release = join(workspacePath, "release");
  const expired = join(workspacePath, "expired");
  const finished = join(workspacePath, "finished");
  await writeProjectExtension(
    workspacePath,
    "blocking-extension.ts",
    `
    import { existsSync, writeFileSync } from "node:fs";
    export default function blockingExtension(pi) {
      pi.registerCommand("hold-runtime", {
        description: "Hold only this test's agent runtime until the test releases it",
        handler: async () => {
          writeFileSync(${JSON.stringify(started)}, String(process.pid));
          const deadline = Date.now() + 10_000;
          while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) {}
          if (!existsSync(${JSON.stringify(release)})) writeFileSync(${JSON.stringify(expired)}, "expired");
          writeFileSync(${JSON.stringify(finished)}, "finished");
        },
      });
    }
  `,
  );
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const page = await harness.firstWindow();
    await createNamedThread(page, "Isolated runtime");
    const doctor = await harness.electronApp.evaluate(({ app }) => {
      const hooks = (
        globalThis as { __PI_APP_TEST_HOOKS?: { agentRuntimeInfo(): { pid?: number } } }
      ).__PI_APP_TEST_HOOKS;
      return {
        mainPid: process.pid,
        runtime: hooks?.agentRuntimeInfo(),
        metrics: app.getAppMetrics().map((metric) => ({ pid: metric.pid, name: metric.name })),
      };
    });
    expect(doctor.runtime?.pid).toBeGreaterThan(0);
    expect(doctor.runtime?.pid).not.toBe(doctor.mainPid);
    expect(doctor.metrics).toContainEqual({ pid: doctor.runtime?.pid, name: "Pi agent runtime" });
    const composer = page.getByTestId("composer");
    await composer.fill("/hold-runtime ");
    await composer.press("Enter");
    await expect.poll(() => existsSync(started)).toBe(true);
    // The fixture can only finish after we release it (or create the failing expiry marker).
    // A call returning after a main-thread freeze cannot make this assertion pass.
    await composer.pressSequentially("Typing stays available while the runtime is busy.");
    await expect(composer).toHaveValue("Typing stays available while the runtime is busy.");
    // This read crosses renderer -> main and must return before the runtime is released.
    // Draft persistence is ordered behind the still-pending extension command.
    const state = await getDesktopState(page);
    expect(state.selectedSessionId).toBeTruthy();
    expect(existsSync(finished)).toBe(false);
    expect(existsSync(expired)).toBe(false);
    await writeFile(release, "release");
    await expect.poll(() => existsSync(finished)).toBe(true);
    expect(existsSync(expired)).toBe(false);
  } finally {
    await writeFile(release, "release");
    await harness.close();
  }
});

test("runtime loss clears running UI, reports failure, and leaves main and the draft usable", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("agent-runtime-exit");
  const server = await startHangingOpenAiServer();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "runtime-exit-test",
      defaultModel: "pending",
      enabledModels: ["runtime-exit-test/pending"],
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "runtime-exit-test": {
          baseUrl: server.baseUrl,
          api: "openai-completions",
          apiKey: "LOCAL_TEST",
          models: [{ id: "pending" }],
        },
      },
    }),
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    scrubProviderEnv: true,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const page = await harness.firstWindow();
    await createNamedThread(page, "Runtime exit");
    await page.getByTestId("composer").fill("Hold this actual provider request open");
    await page.getByTestId("send").click();
    await expect.poll(server.pendingRequestCount).toBe(1);
    await expect(page.getByRole("button", { name: "Stop run", exact: true })).toBeVisible();
    await page.getByTestId("composer").fill("Draft before runtime exit");
    await harness.electronApp.evaluate(() => {
      const info = (
        globalThis as { __PI_APP_TEST_HOOKS?: { agentRuntimeInfo(): { pid?: number } } }
      ).__PI_APP_TEST_HOOKS?.agentRuntimeInfo();
      if (!info?.pid || info.pid === process.pid) throw new Error("Missing isolated runtime PID");
      process.kill(info.pid, "SIGKILL");
    });
    await expect
      .poll(async () => (await getDesktopState(page)).lastError)
      .toContain("Agent runtime stopped unexpectedly");
    await expect(page.getByTestId("composer")).toHaveValue("Draft before runtime exit");
    await page.getByTestId("composer").pressSequentially(" and after");
    await expect(page.getByTestId("composer")).toHaveValue("Draft before runtime exit and after");
    expect(
      (await getDesktopState(page)).workspaces
        .flatMap((workspace) => workspace.sessions)
        .every((session) => session.status !== "running"),
    ).toBe(true);
    await page.getByTestId("send").click();
    await expect
      .poll(async () => (await getDesktopState(page)).lastError)
      .toContain("Agent runtime stopped unexpectedly");
    await expect(page.getByRole("button", { name: "Stop run", exact: true })).toHaveCount(0);
    await expect.poll(server.pendingRequestCount).toBe(0);
  } finally {
    await harness.close();
    await server.close();
  }
});
