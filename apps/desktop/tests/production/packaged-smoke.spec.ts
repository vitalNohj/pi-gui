import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
  resolvePackagedAppExecutable,
  writeProjectExtension,
} from "../helpers/electron-app";
import { assertPackagedAppCanStartThread } from "./packaged-smoke-assertions";

test("launches the packaged app bundle and starts a thread through the real UI", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir("pi-gui-packaged-user-data-");
  const workspacePath = await makeWorkspace("packaged-smoke-workspace");
  await writeProjectExtension(
    workspacePath,
    "runtime-check.ts",
    `
    export default function runtimeCheck(pi) {
      pi.registerCommand("runtime-check", {
        handler: async (_args, ctx) => ctx.ui.setStatus("runtime", "Runtime PID " + process.pid),
      });
    }
  `,
  );
  const promptText = "Packaged smoke thread";
  const expectedExecutablePath = await resolvePackagedAppExecutable(
    resolve(__dirname, "../..", process.env.PI_APP_TEST_RELEASE_DIR?.trim() || "release"),
  );
  const harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await assertPackagedAppCanStartThread(harness, window, {
      expectedExecutablePath,
      promptText,
      workspacePath,
    });
    // An ASAR-packaged utility entry must execute the extension, not silently fall back to main.
    const identity = await harness.electronApp.evaluate(({ app }) => {
      const runtime = (
        globalThis as {
          __PI_APP_TEST_HOOKS?: { agentRuntimeInfo(): { pid?: number } };
        }
      ).__PI_APP_TEST_HOOKS?.agentRuntimeInfo();
      return {
        mainPid: process.pid,
        runtimePid: runtime?.pid,
        ownedRuntime: app
          .getAppMetrics()
          .some((metric) => metric.pid === runtime?.pid && metric.name === "Pi agent runtime"),
      };
    });
    if (!identity.runtimePid || identity.runtimePid === identity.mainPid || !identity.ownedRuntime)
      throw new Error("The packaged app did not start its isolated runtime");
    await window.getByTestId("composer").fill("/runtime-check ");
    await window.getByTestId("composer").press("Enter");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      `Runtime PID ${identity.runtimePid}`,
    );
  } finally {
    await harness.close();
  }
});
