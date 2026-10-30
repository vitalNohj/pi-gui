import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionFileCatalogStorage, WorkspaceCatalogEntry } from "@pi-gui/catalogs";
import { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import { sessionKey, type SessionRef } from "@pi-gui/session-driver";
import type { RuntimeLoginCallbacks } from "@pi-gui/session-driver/runtime-types";
import { DesktopExtensionViewOwner } from "../extensions/extension-view-owner";
import { extensionFrameDocument } from "../extensions/extension-frame-document";
import { createOrchestrationRuntimeExtension } from "../orchestration/orchestration-runtime";
import { createScheduledTaskRuntimeExtension } from "../scheduled-tasks/scheduled-task-runtime";
import {
  FILE_CATALOG_METHODS,
  RUNTIME_BUILTINS,
  RUNTIME_METHODS,
  SESSION_CATALOG_METHODS,
  SESSION_METHODS,
  VIEW_METHODS,
  WORKSPACE_CATALOG_METHODS,
  WORKTREE_CATALOG_METHODS,
  type AgentRuntimeMethods,
  type RuntimeHostMethods,
  type RuntimeInvocation,
  type RuntimePreferences,
  type RuntimeSessionIdentity,
} from "./runtime-contract";
import { RuntimeRpcPeer, invokeRuntimeMethod, remoteRuntimeMethods } from "./runtime-rpc";

const parent = process.parentPort;
if (!parent) throw new Error("The Pi runtime must be launched as an Electron utility process");
const rpc = new RuntimeRpcPeer<AgentRuntimeMethods, RuntimeHostMethods>({
  post: (message) => parent.postMessage(message),
});
parent.on("message", ({ data }) => rpc.receive(data));

const workspaceByPath = new Map<string, string>();
const disabledBuiltins = new Set<string>();
const flagsBySession = new Map<string, RuntimePreferences["sessionFlags"]>();
const subscriptions = new Map<string, () => void>();
const ownedSessions = new Map<string, SessionRef>();
let driver: PiSdkDriver | undefined;
let views: DesktopExtensionViewOwner | undefined;

function requireDriver(): PiSdkDriver {
  if (!driver) throw new Error("The agent runtime is not initialized");
  return driver;
}
function requireViews(): DesktopExtensionViewOwner {
  if (!views) throw new Error("The extension runtime is not initialized");
  return views;
}
function preferences(input: RuntimePreferences): void {
  disabledBuiltins.clear();
  for (const name of input.disabledBuiltins) disabledBuiltins.add(name);
  if (input.sessionFlags)
    flagsBySession.set(sessionKey(input.sessionFlags.target), input.sessionFlags);
}
function identity(ctx: ExtensionContext): RuntimeSessionIdentity {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: path.resolve(ctx.sessionManager.getCwd?.() ?? ctx.cwd),
  };
}
function rememberWorkspace(entry: WorkspaceCatalogEntry | undefined): void {
  if (entry) workspaceByPath.set(path.resolve(entry.path), entry.workspaceId);
}
function catalogStorage(): SessionFileCatalogStorage {
  const workspaces = remoteRuntimeMethods<SessionFileCatalogStorage["workspaces"]>(
    WORKSPACE_CATALOG_METHODS,
    (method, args) => rpc.call("catalog", ["workspaces", method, args]),
  );
  return {
    ...remoteRuntimeMethods<Pick<SessionFileCatalogStorage, (typeof FILE_CATALOG_METHODS)[number]>>(
      FILE_CATALOG_METHODS,
      (method, args) => rpc.call("catalog", ["files", method, args]),
    ),
    workspaces: {
      ...workspaces,
      async listWorkspaces() {
        const snapshot = await workspaces.listWorkspaces();
        for (const entry of snapshot.workspaces) rememberWorkspace(entry);
        return snapshot;
      },
      async getWorkspace(id) {
        const entry = await workspaces.getWorkspace(id);
        rememberWorkspace(entry);
        return entry;
      },
      async upsertWorkspace(entry) {
        await workspaces.upsertWorkspace(entry);
        rememberWorkspace(entry);
      },
    },
    sessions: remoteRuntimeMethods<SessionFileCatalogStorage["sessions"]>(
      SESSION_CATALOG_METHODS,
      (method, args) => rpc.call("catalog", ["sessions", method, args]),
    ),
    worktrees: remoteRuntimeMethods<SessionFileCatalogStorage["worktrees"]>(
      WORKTREE_CATALOG_METHODS,
      (method, args) => rpc.call("catalog", ["worktrees", method, args]),
    ),
  };
}
function rememberTarget(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (
    "workspaceId" in value &&
    "sessionId" in value &&
    typeof value.workspaceId === "string" &&
    typeof value.sessionId === "string"
  ) {
    const target = { workspaceId: value.workspaceId, sessionId: value.sessionId };
    ownedSessions.set(sessionKey(target), target);
  }
  if ("sessionRef" in value) rememberTarget(value.sessionRef);
}
async function sessionCall(input: RuntimeInvocation): Promise<unknown> {
  preferences(input.preferences);
  rememberTarget(input.args[0]);
  const result = await invokeRuntimeMethod(
    requireDriver(),
    SESSION_METHODS,
    input.method,
    input.args,
  );
  rememberTarget(result);
  return result;
}
async function shutdown(): Promise<void> {
  for (const stop of subscriptions.values()) stop();
  subscriptions.clear();
  await views?.dispose();
  if (driver)
    await Promise.allSettled(
      [...ownedSessions.values()].map((target) => driver!.closeSession(target)),
    );
  ownedSessions.clear();
}

rpc.setHandlers({
  initialize: async ([input]) => {
    if (driver) throw new Error("The agent runtime is already initialized");
    views = new DesktopExtensionViewOwner({
      frameDocument: extensionFrameDocument,
      hostAssets: input.hostAssets,
      onHostAction: (context) => rpc.call("viewHostAction", [context]),
      onDiagnostic: (target, source, message) => {
        void rpc.call("viewDiagnostic", [target, source, message]).catch(() => undefined);
      },
    });
    const viewOwner = views;
    viewOwner.subscribe((target) => {
      void rpc.call("viewCatalog", [target, viewOwner.listViews(target)]).catch(() => undefined);
    });
    driver = new PiSdkDriver({
      catalogStorage: catalogStorage(),
      turnCaptureTimeoutMs: input.turnCaptureTimeoutMs,
      onTurnCaptureBoundary: (boundary, signal) => rpc.call("turnCapture", [boundary], { signal }),
      openUrl: (url) => {
        void rpc
          .call("openUrl", [url])
          .catch((error: unknown) => console.error("[runtime] Failed to open sign-in URL", error));
      },
      generateThreadTitleOverride: (workspace, options) =>
        rpc.call("threadTitle", [workspace, options]),
      isBuiltinExtensionEnabled: (name) => !disabledBuiltins.has(name),
      extensionFlagValuesForSession: (target) => flagsBySession.get(sessionKey(target))?.values,
      desktopExtensions: {
        onChanged: (runtime) => viewOwner.replaceRuntime(runtime),
        onInvalidated: ({ target, generation }) => viewOwner.invalidateRuntime(target, generation),
      },
      builtinExtensions: [
        {
          ...RUNTIME_BUILTINS[0],
          factory: createOrchestrationRuntimeExtension({
            createChildThread: (ctx, input) =>
              rpc.call("createChildThread", [identity(ctx), input]),
            listThreads: (ctx) => rpc.call("listThreads", [identity(ctx)]),
            readThread: (ctx, threadId) => rpc.call("readThread", [identity(ctx), threadId]),
            sendMessageToThread: (ctx, input) =>
              rpc.call("sendMessageToThread", [identity(ctx), input]),
          }),
        },
        {
          ...RUNTIME_BUILTINS[1],
          factory: createScheduledTaskRuntimeExtension(
            {
              createScheduledTask: (ctx, input) =>
                rpc.call("createScheduledTask", [identity(ctx), input]),
              listScheduledTasks: () => rpc.call("listScheduledTasks", []),
              updateScheduledTask: (_ctx, input) => rpc.call("updateScheduledTask", [input]),
            },
            (ctx) => workspaceByPath.get(identity(ctx).cwd),
          ),
        },
      ],
    });
  },
  session: ([input]) => sessionCall(input),
  runtime: ([input]) => {
    preferences(input.preferences);
    return invokeRuntimeMethod(
      requireDriver().runtimeSupervisor,
      RUNTIME_METHODS,
      input.method,
      input.args,
    );
  },
  subscribe: ([token, target]) => {
    if (subscriptions.has(token)) throw new Error("Duplicate runtime subscription");
    subscriptions.set(
      token,
      requireDriver().subscribe(target, (event) => {
        rememberTarget(event.sessionRef);
        return rpc.call("sessionEvent", [token, event]);
      }),
    );
  },
  unsubscribe: ([token]) => {
    subscriptions.get(token)?.();
    subscriptions.delete(token);
  },
  login: async ([token, workspace, providerId, settings], signal) => {
    preferences(settings);
    const callbacks: RuntimeLoginCallbacks = {
      signal,
      onAuth: async (...args) => {
        await rpc.call("loginEvent", [token, { type: "onAuth", args }], { signal });
      },
      onPrompt: async (...args) =>
        String(await rpc.call("loginEvent", [token, { type: "onPrompt", args }], { signal })),
      onProgress: async (...args) => {
        await rpc.call("loginEvent", [token, { type: "onProgress", args }], { signal });
      },
      onManualCodeInput: async () =>
        String(
          await rpc.call("loginEvent", [token, { type: "onManualCodeInput", args: [] }], {
            signal,
          }),
        ),
    };
    return requireDriver().runtimeSupervisor.login(workspace, providerId, callbacks);
  },
  openView: async ([token, input]) => {
    const owner = requireViews();
    const connection = await owner.openConnection(input, (message) => {
      void rpc.call("viewMessage", [token, message]).catch(() => owner.closeSender(input.senderId));
    });
    return {
      ...connection,
      context: owner.getConnectionContext(connection.connectionId, input.senderId),
    };
  },
  view: ([method, args]) => invokeRuntimeMethod(requireViews(), VIEW_METHODS, method, args),
  viewAsset: async ([url]) => {
    const response = await requireViews().assetResponse(url);
    return {
      status: response.status,
      headers: [...response.headers],
      body: new Uint8Array(await response.arrayBuffer()),
    };
  },
  shutdown: () => shutdown(),
});
