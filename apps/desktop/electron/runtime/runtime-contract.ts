import type { SessionFileCatalogStorage } from "@pi-gui/catalogs";
import type { PiSdkDriver, PiSdkDriverConfig, RuntimeSupervisor } from "@pi-gui/pi-sdk-driver";
import type {
  ExtensionFlagValues,
  SessionDriverEvent,
  SessionRef,
  WorkspaceRef,
} from "@pi-gui/session-driver";
import type { RuntimeLoginCallbacks, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { DesktopHostAction } from "@pi-gui/extension-ui/browser";
import type {
  DesktopExtensionViewInfo,
  DesktopExtensionConnectionContext,
  DesktopExtensionHostAsset,
  DesktopExtensionViewOwner,
} from "../extensions/extension-view-owner";
import type { OrchestrationRuntimeBridge } from "../orchestration/orchestration-runtime";
import type { ScheduledTaskRuntimeBridge } from "../scheduled-tasks/scheduled-task-runtime";

/** The agent runtime process was lost. Every session it had open must be reopened. */
export const AGENT_RUNTIME_UNAVAILABLE = "agent_runtime_unavailable";
/** One session lost its event connection. It must be reopened before it is used again. */
export const AGENT_SESSION_DETACHED = "agent_session_detached";
/** Error codes after which the store must reopen the session on its next use. */
export const DETACHED_SESSION_ERROR_CODES: ReadonlySet<string> = new Set([
  AGENT_RUNTIME_UNAVAILABLE,
  AGENT_SESSION_DETACHED,
]);

export const SESSION_METHODS = [
  "createSession",
  "validateForkSession",
  "forkSession",
  "openSession",
  "archiveSession",
  "archiveSessionIfIdle",
  "unarchiveSession",
  "sendUserMessage",
  "replaceQueuedMessages",
  "cancelCurrentRun",
  "setSessionModel",
  "setSessionThinkingLevel",
  "renameSession",
  "compactSession",
  "reloadSession",
  "reloadSessionWhenIdle",
  "getSessionTree",
  "navigateSessionTree",
  "getSessionCommands",
  "respondToHostUiRequest",
  "closeSession",
  "releaseSession",
  "listWorkspaces",
  "listSessions",
  "syncWorkspace",
  "reconcileWorkspace",
  "getSessionFilePath",
  "renameWorkspace",
  "removeWorkspace",
  "getTranscript",
  "getSessionSchemaInfo",
  "generateThreadTitle",
] as const satisfies readonly (keyof PiSdkDriver)[];
export const RUNTIME_METHODS = [
  "getRuntimeSnapshot",
  "refreshRuntime",
  "logout",
  "setProviderApiKey",
  "listCustomProviders",
  "setCustomProvider",
  "deleteCustomProvider",
  "setDefaultModel",
  "setProjectDefaultModel",
  "setDefaultThinkingLevel",
  "setProjectDefaultThinkingLevel",
  "setEnableSkillCommands",
  "getCodemodeAlwaysOn",
  "setCodemodeAlwaysOn",
  "listMcpServers",
  "addMcpServer",
  "removeMcpServer",
  "setMcpServerEnabled",
  "setScopedModelPatterns",
  "setProjectScopedModelPatterns",
  "getGlobalModelSettings",
  "getCurrentModelSettings",
  "scopeModels",
  "setSkillEnabled",
  "setExtensionEnabled",
] as const satisfies readonly (keyof RuntimeSupervisor)[];
export const VIEW_METHODS = [
  "receive",
  "invokeHostAction",
  "closeConnection",
  "closeSender",
  "dispose",
] as const;

type AsyncMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};
export type DesktopRuntimeSupervisor = AsyncMethods<
  Pick<RuntimeSupervisor, (typeof RUNTIME_METHODS)[number]>
> &
  Pick<RuntimeSupervisor, "builtinExtensionName" | "login">;
export type DesktopSessionDriver = Pick<
  PiSdkDriver,
  (typeof SESSION_METHODS)[number] | "subscribe"
> & {
  readonly runtimeSupervisor: DesktopRuntimeSupervisor;
};
export type DesktopDriverFactory = (options: PiSdkDriverConfig) => DesktopSessionDriver;
export type DesktopExtensionViewHost = Pick<
  DesktopExtensionViewOwner,
  | "subscribe"
  | "listViews"
  | "openConnection"
  | "getConnectionContext"
  | "receive"
  | "invokeHostAction"
  | "closeConnection"
  | "closeSender"
  | "assetResponse"
  | "dispose"
>;

export interface RuntimePreferences {
  readonly disabledBuiltins: readonly string[];
  readonly sessionFlags?: { readonly target: SessionRef; readonly values?: ExtensionFlagValues };
}
export interface RuntimeInvocation {
  readonly method: string;
  readonly args: unknown[];
  readonly preferences: RuntimePreferences;
}
export interface RuntimeSessionIdentity {
  readonly sessionId: string;
  readonly cwd: string;
}
export interface RuntimeInit {
  readonly turnCaptureTimeoutMs?: number;
  readonly hostAssets: Readonly<Record<string, DesktopExtensionHostAsset>>;
}
export interface RuntimeAssetResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}

type BridgeArgs<T> = T extends (ctx: never, ...args: infer A) => unknown ? A : never;
type BridgeResult<T> = T extends (...args: never[]) => infer R ? R : never;
type LoginCallbackName = Exclude<keyof RuntimeLoginCallbacks, "signal">;
export type RuntimeLoginEvent = {
  [K in LoginCallbackName]: {
    readonly type: K;
    readonly args: Parameters<NonNullable<RuntimeLoginCallbacks[K]>>;
  };
}[LoginCallbackName];

export interface AgentRuntimeMethods {
  initialize(input: RuntimeInit): Promise<void>;
  session(input: RuntimeInvocation): Promise<unknown>;
  runtime(input: RuntimeInvocation): Promise<unknown>;
  subscribe(token: string, target: SessionRef): void;
  unsubscribe(token: string): void;
  login(
    token: string,
    workspace: WorkspaceRef,
    providerId: string,
    preferences: RuntimePreferences,
  ): Promise<RuntimeSnapshot>;
  openView(
    token: string,
    input: Parameters<DesktopExtensionViewOwner["openConnection"]>[0],
  ): Promise<{
    readonly connectionId: string;
    readonly frameUrl: string;
    readonly context: DesktopExtensionConnectionContext;
  }>;
  view(method: (typeof VIEW_METHODS)[number], args: unknown[]): Promise<unknown>;
  viewAsset(url: string): Promise<RuntimeAssetResponse>;
  shutdown(): Promise<void>;
}

/** Main owns these narrow capabilities. No Pi object, closure, or factory crosses the wire. */
export interface RuntimeHostMethods {
  catalog(
    scope: "workspaces" | "sessions" | "worktrees" | "files",
    method: string,
    args: unknown[],
  ): Promise<unknown>;
  sessionEvent(token: string, event: SessionDriverEvent): Promise<void>;
  viewCatalog(target: SessionRef, views: readonly DesktopExtensionViewInfo[]): void;
  viewMessage(token: string, message: unknown): void;
  viewHostAction(
    context: DesktopExtensionConnectionContext & { readonly action: DesktopHostAction },
  ): Promise<void>;
  viewDiagnostic(target: SessionRef, source: string, message: string): void;
  openUrl(url: string): Promise<void>;
  turnCapture(
    boundary: Parameters<NonNullable<PiSdkDriverConfig["onTurnCaptureBoundary"]>>[0],
  ): Promise<void>;
  threadTitle(
    workspace: WorkspaceRef,
    options: Parameters<PiSdkDriver["generateThreadTitle"]>[1],
  ): Promise<string | null | undefined>;
  loginEvent(token: string, event: RuntimeLoginEvent): Promise<string | void>;
  createChildThread(
    identity: RuntimeSessionIdentity,
    ...args: BridgeArgs<OrchestrationRuntimeBridge["createChildThread"]>
  ): BridgeResult<OrchestrationRuntimeBridge["createChildThread"]>;
  archiveChildThreads(
    identity: RuntimeSessionIdentity,
    ...args: BridgeArgs<OrchestrationRuntimeBridge["archiveChildThreads"]>
  ): BridgeResult<OrchestrationRuntimeBridge["archiveChildThreads"]>;
  listThreads(
    identity: RuntimeSessionIdentity,
    ...args: BridgeArgs<OrchestrationRuntimeBridge["listThreads"]>
  ): BridgeResult<OrchestrationRuntimeBridge["listThreads"]>;
  readThread(
    identity: RuntimeSessionIdentity,
    ...args: BridgeArgs<OrchestrationRuntimeBridge["readThread"]>
  ): BridgeResult<OrchestrationRuntimeBridge["readThread"]>;
  sendMessageToThread(
    identity: RuntimeSessionIdentity,
    ...args: BridgeArgs<OrchestrationRuntimeBridge["sendMessageToThread"]>
  ): BridgeResult<OrchestrationRuntimeBridge["sendMessageToThread"]>;
  createScheduledTask(
    identity: RuntimeSessionIdentity,
    ...args: BridgeArgs<ScheduledTaskRuntimeBridge["createScheduledTask"]>
  ): BridgeResult<ScheduledTaskRuntimeBridge["createScheduledTask"]>;
  listScheduledTasks(): BridgeResult<ScheduledTaskRuntimeBridge["listScheduledTasks"]>;
  updateScheduledTask(
    ...args: BridgeArgs<ScheduledTaskRuntimeBridge["updateScheduledTask"]>
  ): BridgeResult<ScheduledTaskRuntimeBridge["updateScheduledTask"]>;
}

export const WORKSPACE_CATALOG_METHODS = [
  "listWorkspaces",
  "getWorkspace",
  "upsertWorkspace",
  "deleteWorkspace",
] as const satisfies readonly (keyof SessionFileCatalogStorage["workspaces"])[];
export const SESSION_CATALOG_METHODS = [
  "listSessions",
  "getSession",
  "upsertSession",
  "setStoppedReplyId",
  "archiveSessionUnlessStopped",
  "deleteSession",
] as const satisfies readonly (keyof SessionFileCatalogStorage["sessions"])[];
export const WORKTREE_CATALOG_METHODS = [
  "listWorktrees",
  "getWorktree",
  "upsertWorktree",
  "deleteWorktree",
  "replaceWorkspaceWorktrees",
] as const satisfies readonly (keyof SessionFileCatalogStorage["worktrees"])[];
export const FILE_CATALOG_METHODS = [
  "getSessionFile",
  "setSessionFile",
  "deleteSessionFile",
  "replaceWorkspaceSessions",
] as const satisfies readonly (keyof SessionFileCatalogStorage)[];

export const RUNTIME_BUILTINS = [
  {
    name: "pi-gui-thread-orchestration",
    displayName: "Thread orchestration",
    description: "Lets pi start, read and message other pi-gui threads",
  },
  {
    name: "pi-gui-scheduled-tasks",
    displayName: "Scheduled tasks",
    description: "Lets pi create and update local pi-gui scheduled tasks",
  },
] as const;
