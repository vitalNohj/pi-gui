import { utilityProcess, type UtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PiSdkDriver, PiSdkDriverConfig, RuntimeSupervisor } from "@pi-gui/pi-sdk-driver";
import type { SessionFileCatalogStorage } from "@pi-gui/catalogs";
import { sessionKey, type SessionEventListener, type SessionRef } from "@pi-gui/session-driver";
import type { RuntimeLoginCallbacks } from "@pi-gui/session-driver/runtime-types";
import type {
  DesktopExtensionConnectionContext,
  DesktopExtensionViewInfo,
} from "../extensions/extension-view-owner";
import {
  FILE_CATALOG_METHODS,
  RUNTIME_BUILTINS,
  RUNTIME_METHODS,
  SESSION_CATALOG_METHODS,
  SESSION_METHODS,
  WORKSPACE_CATALOG_METHODS,
  WORKTREE_CATALOG_METHODS,
  type AgentRuntimeMethods,
  type DesktopExtensionViewHost,
  type DesktopSessionDriver,
  type RuntimeHostMethods,
  type RuntimeInit,
  type RuntimePreferences,
} from "./runtime-contract";
import {
  RuntimeRpcPeer,
  invokeRuntimeMethod,
  remoteRuntimeMethods,
  type RuntimeRpcHandlers,
} from "./runtime-rpc";

type DesktopCapabilities = Pick<
  RuntimeRpcHandlers<RuntimeHostMethods>,
  | "viewHostAction"
  | "viewDiagnostic"
  | "createChildThread"
  | "archiveChildThreads"
  | "listThreads"
  | "readThread"
  | "sendMessageToThread"
  | "createScheduledTask"
  | "listScheduledTasks"
  | "updateScheduledTask"
>;
interface ProcessOptions {
  readonly init: RuntimeInit;
  readonly capabilities: DesktopCapabilities;
  /** Only enabled by the existing main-process test-mode gate. */
  readonly inspectRuntime?: boolean;
}
interface ViewConnection {
  readonly token: string;
  readonly context: DesktopExtensionConnectionContext;
  readonly send: (message: unknown) => void;
}

/** Owns exactly one utility process. Catalog persistence and all Electron capabilities stay here. */
export class AgentRuntimeProcess {
  private readonly child: UtilityProcess;
  private readonly rpc: RuntimeRpcPeer<RuntimeHostMethods, AgentRuntimeMethods>;
  private readonly spawned: Promise<void>;
  private ready: Promise<void> | undefined;
  private driverOptions: PiSdkDriverConfig | undefined;
  private disposed = false;
  private failure: Error | undefined;
  private readonly sessionListeners = new Map<
    string,
    { target: SessionRef; listener: SessionEventListener }
  >();
  private readonly loginCallbacks = new Map<string, RuntimeLoginCallbacks>();
  private readonly viewListeners = new Set<(target: SessionRef) => void>();
  private readonly viewCatalogs = new Map<string, readonly DesktopExtensionViewInfo[]>();
  private readonly viewConnections = new Map<string, ViewConnection>();
  private readonly viewSenders = new Map<string, (message: unknown) => void>();
  private inspectorUrl: string | undefined;

  constructor(private readonly options: ProcessOptions) {
    this.child = utilityProcess.fork(path.join(__dirname, "agent-runtime.js"), [], {
      serviceName: "Pi agent runtime",
      stdio: "pipe",
      ...(options.inspectRuntime ? { execArgv: ["--inspect=127.0.0.1:0"] } : {}),
    });
    this.rpc = new RuntimeRpcPeer({ post: (message) => this.child.postMessage(message) });
    this.child.on("message", (message) => this.rpc.receive(message));
    this.spawned = new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("exit", (code) =>
        reject(new Error(`Agent runtime exited before startup (${code})`)),
      );
      this.child.once("error", (_type, location, details) =>
        reject(new Error(`Agent runtime startup failed: ${location}: ${details}`)),
      );
    });
    // A failed startup is also observed by ready(); avoid an unhandled rejection before composition.
    void this.spawned.catch((error: unknown) => this.fail(error));
    this.child.on("error", (_type, location, details) => {
      this.fail(new Error(`Agent runtime failed: ${location}: ${details}`));
    });
    this.child.on("exit", (code) => {
      if (!this.disposed)
        this.fail(
          new Error(
            `Agent runtime stopped unexpectedly (${code}). Restart pi-gui to reconnect. No operation was replayed.`,
          ),
        );
    });
    this.child.stdout?.pipe(process.stdout);
    this.child.stderr?.on("data", (chunk: Buffer) => {
      if (options.inspectRuntime && !this.inspectorUrl) {
        this.inspectorUrl = /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.exec(chunk.toString())?.[0];
      }
    });
    this.child.stderr?.pipe(process.stderr);
    this.rpc.setHandlers({
      ...options.capabilities,
      catalog: ([scope, method, args]) => {
        const catalogs = this.catalogs();
        switch (scope) {
          case "workspaces":
            return invokeRuntimeMethod(
              catalogs.workspaces,
              WORKSPACE_CATALOG_METHODS,
              method,
              args,
            );
          case "sessions":
            return invokeRuntimeMethod(catalogs.sessions, SESSION_CATALOG_METHODS, method, args);
          case "worktrees":
            return invokeRuntimeMethod(catalogs.worktrees, WORKTREE_CATALOG_METHODS, method, args);
          case "files":
            return invokeRuntimeMethod(catalogs, FILE_CATALOG_METHODS, method, args);
        }
      },
      sessionEvent: async ([token, event]) => {
        const subscription = this.sessionListeners.get(token);
        if (subscription) {
          // Pi can replace a session in place (ctx.newSession); the subscription follows it.
          subscription.target = event.sessionRef;
          await subscription.listener(event);
        }
      },
      viewCatalog: ([target, views]) => {
        this.viewCatalogs.set(sessionKey(target), views);
        for (const connection of [...this.viewConnections.values()]) {
          const context = connection.context;
          if (
            sessionKey(context.target) === sessionKey(target) &&
            !views.some(
              (view) =>
                view.generation === context.generation &&
                view.extensionId === context.extensionId &&
                view.id === context.viewId &&
                view.state === "ready",
            )
          )
            this.forgetView(connection);
        }
        for (const listener of this.viewListeners) listener(target);
      },
      viewMessage: ([token, message]) => {
        this.viewSenders.get(token)?.(message);
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "closed"
        ) {
          const connection = [...this.viewConnections.values()].find(
            (entry) => entry.token === token,
          );
          if (connection) this.forgetView(connection);
        }
      },
      openUrl: async ([url]) => {
        await this.driverOptions?.openUrl?.(url);
      },
      turnCapture: async ([boundary], signal) => {
        await this.driverOptions?.onTurnCaptureBoundary?.(boundary, signal);
      },
      threadTitle: ([workspace, input]) =>
        this.driverOptions?.generateThreadTitleOverride?.(workspace, input),
      loginEvent: async ([token, event]) => {
        const callbacks = this.loginCallbacks.get(token);
        if (!callbacks || callbacks.signal?.aborted) throw new Error("Sign-in was cancelled");
        switch (event.type) {
          case "onAuth":
            await callbacks.onAuth(...event.args);
            return;
          case "onProgress":
            await callbacks.onProgress?.(...event.args);
            return;
          case "onPrompt":
            return callbacks.onPrompt(...event.args);
          case "onManualCodeInput": {
            if (!callbacks.onManualCodeInput) throw new Error("Manual sign-in is unavailable");
            return callbacks.onManualCodeInput();
          }
        }
      },
    });
  }

  get diagnostics(): { readonly pid?: number; readonly inspectorUrl?: string } {
    return { pid: this.child.pid, inspectorUrl: this.inspectorUrl };
  }

  createDriver(options: PiSdkDriverConfig): DesktopSessionDriver {
    if (this.driverOptions) throw new Error("The desktop runtime driver is already composed");
    this.driverOptions = options;
    this.ready = this.spawned.then(() =>
      this.rpc.call("initialize", [
        {
          ...this.options.init,
          turnCaptureTimeoutMs: options.turnCaptureTimeoutMs,
        },
      ]),
    );
    void this.ready.catch((error: unknown) => this.fail(error));
    const sessionMethods = remoteRuntimeMethods<
      Pick<PiSdkDriver, (typeof SESSION_METHODS)[number]>
    >(SESSION_METHODS, async (method, args) => {
      await this.requireReady();
      return this.rpc.call("session", [{ method, args, preferences: this.preferences(args[0]) }]);
    });
    const runtimeMethods = remoteRuntimeMethods<
      Pick<RuntimeSupervisor, (typeof RUNTIME_METHODS)[number]>
    >(RUNTIME_METHODS, async (method, args) => {
      await this.requireReady();
      return this.rpc.call("runtime", [{ method, args, preferences: this.preferences() }]);
    });
    return {
      ...sessionMethods,
      subscribe: (target, listener) => {
        const token = randomUUID();
        this.sessionListeners.set(token, { target, listener });
        void this.requireReady()
          .then(() => this.rpc.call("subscribe", [token, target]))
          .catch((error: unknown) => this.fail(error));
        return () => {
          this.sessionListeners.delete(token);
          if (!this.failure && !this.disposed)
            void this.requireReady()
              .then(() => this.rpc.call("unsubscribe", [token]))
              .catch(() => undefined);
        };
      },
      runtimeSupervisor: {
        ...runtimeMethods,
        builtinExtensionName: (requestedPath) =>
          RUNTIME_BUILTINS.find((entry) => `<inline:${entry.name}>` === requestedPath)?.name,
        login: async (workspace, providerId, callbacks) => {
          await this.requireReady();
          const token = randomUUID();
          this.loginCallbacks.set(token, callbacks);
          try {
            return await this.rpc.call(
              "login",
              [token, workspace, providerId, this.preferences()],
              { signal: callbacks.signal },
            );
          } finally {
            this.loginCallbacks.delete(token);
          }
        },
      },
    };
  }

  readonly extensionViews: DesktopExtensionViewHost = {
    subscribe: (listener) => {
      this.viewListeners.add(listener);
      return () => {
        this.viewListeners.delete(listener);
      };
    },
    listViews: (target) => this.viewCatalogs.get(sessionKey(target)) ?? [],
    openConnection: async (input, send) => {
      await this.requireReady();
      const token = randomUUID();
      this.viewSenders.set(token, send);
      try {
        const connection = await this.rpc.call("openView", [token, input]);
        this.viewConnections.set(connection.connectionId, {
          token,
          context: connection.context,
          send,
        });
        return { connectionId: connection.connectionId, frameUrl: connection.frameUrl };
      } catch (error) {
        this.viewSenders.delete(token);
        throw error;
      }
    },
    getConnectionContext: (id, senderId) => {
      const connection = this.viewConnections.get(id);
      if (!connection) throw new Error("Desktop extension view connection is closed");
      if (connection.context.senderId !== senderId)
        throw new Error("Desktop view connection belongs to another window");
      return { ...connection.context, target: { ...connection.context.target } };
    },
    receive: async (id, senderId, message) => {
      await this.requireReady();
      await this.rpc.call("view", ["receive", [id, senderId, message]]);
    },
    invokeHostAction: async (id, senderId, action) => {
      await this.requireReady();
      await this.rpc.call("view", ["invokeHostAction", [id, senderId, action]]);
    },
    closeConnection: (id, senderId) => {
      const connection = this.viewConnections.get(id);
      if (connection) {
        this.extensionViews.getConnectionContext(id, senderId);
        this.forgetView(connection);
      }
      this.sendViewClose("closeConnection", [id, senderId]);
    },
    closeSender: (senderId) => {
      for (const connection of [...this.viewConnections.values()])
        if (connection.context.senderId === senderId) this.forgetView(connection);
      this.sendViewClose("closeSender", [senderId]);
    },
    assetResponse: async (url) => {
      try {
        await this.requireReady();
        const response = await this.rpc.call("viewAsset", [url]);
        return new Response(response.body, {
          status: response.status,
          headers: [...response.headers].map(([key, value]) => [key, value]),
        });
      } catch {
        return new Response("Extension runtime is unavailable", { status: 503 });
      }
    },
    dispose: async () => {
      for (const connection of [...this.viewConnections.values()]) this.forgetView(connection);
      this.viewCatalogs.clear();
      if (!this.failure && this.ready && !this.disposed) {
        await this.requireReady();
        await this.rpc.call("view", ["dispose", []]);
      }
    },
  };

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // A stuck extension must not hold app quit forever. Never retry an unknown-outcome call.
    let timer: NodeJS.Timeout | undefined;
    try {
      if (!this.failure && this.ready)
        await Promise.race([
          this.ready.then(() => this.rpc.call("shutdown", [])),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5_000);
          }),
        ]);
    } catch {
      /* The process may already be gone. */
    } finally {
      if (timer) clearTimeout(timer);
      this.rpc.close();
      this.child.kill();
    }
  }

  private requireReady(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.disposed) return Promise.reject(new Error("Agent runtime is shutting down"));
    return this.ready ?? Promise.reject(new Error("The desktop runtime driver is not composed"));
  }
  private catalogs(): SessionFileCatalogStorage {
    const catalogs = this.driverOptions?.catalogStorage;
    if (!catalogs) throw new Error("The desktop catalog owner is unavailable");
    return catalogs;
  }
  private preferences(value?: unknown): RuntimePreferences {
    const options = this.driverOptions;
    const target =
      value &&
      typeof value === "object" &&
      "workspaceId" in value &&
      "sessionId" in value &&
      typeof value.workspaceId === "string" &&
      typeof value.sessionId === "string"
        ? { workspaceId: value.workspaceId, sessionId: value.sessionId }
        : undefined;
    return {
      disabledBuiltins: RUNTIME_BUILTINS.filter(
        (entry) => options?.isBuiltinExtensionEnabled?.(entry.name) === false,
      ).map((entry) => entry.name),
      ...(target
        ? { sessionFlags: { target, values: options?.extensionFlagValuesForSession?.(target) } }
        : {}),
    };
  }
  private sendViewClose(method: "closeConnection" | "closeSender", args: unknown[]): void {
    if (this.failure || this.disposed) return;
    void this.requireReady()
      .then(() => this.rpc.call("view", [method, args]))
      .catch(() => undefined);
  }
  private forgetView(connection: ViewConnection): void {
    this.viewConnections.delete(connection.context.connectionId);
    this.viewSenders.delete(connection.token);
  }
  private fail(value: unknown): void {
    if (this.failure || this.disposed) return;
    const error = value instanceof Error ? value : new Error(String(value));
    this.failure = error;
    this.rpc.close(error);
    for (const connection of [...this.viewConnections.values()]) {
      connection.send({ type: "closed", reason: error.message });
      this.forgetView(connection);
    }
    for (const [key] of this.viewCatalogs) this.viewCatalogs.set(key, []);
    for (const { target, listener } of this.sessionListeners.values()) {
      void Promise.resolve(
        listener({
          type: "runFailed",
          sessionRef: target,
          timestamp: new Date().toISOString(),
          error: { code: "agent_runtime_unavailable", message: error.message },
        }),
      ).catch(() => undefined);
    }
  }
}
