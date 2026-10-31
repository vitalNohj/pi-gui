import { utilityProcess, type UtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PiSdkDriver, PiSdkDriverConfig, RuntimeSupervisor } from "@pi-gui/pi-sdk-driver";
import type { SessionFileCatalogStorage } from "@pi-gui/catalogs";
import {
  sessionKey,
  type SessionDriverEvent,
  type SessionEventListener,
  type SessionRef,
} from "@pi-gui/session-driver";
import type { RuntimeLoginCallbacks } from "@pi-gui/session-driver/runtime-types";
import type {
  DesktopExtensionConnectionContext,
  DesktopExtensionViewInfo,
} from "../extensions/extension-view-owner";
import {
  AGENT_RUNTIME_UNAVAILABLE,
  AGENT_SESSION_DETACHED,
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
import { RuntimeRestartBudget } from "./runtime-restart-budget";

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
  /** Tests may tighten the restart limit. */
  readonly restartBudget?: RuntimeRestartBudget;
}
interface ViewConnection {
  readonly token: string;
  readonly context: DesktopExtensionConnectionContext;
  readonly send: (message: unknown) => void;
}
interface SessionSubscription {
  target: SessionRef;
  readonly listener: SessionEventListener;
  /** The runtime this listener is registered with, once the subscribe call was sent. */
  generation: RuntimeGeneration | undefined;
}

/** One utility process and its connection. A lost generation is never reused. */
interface RuntimeGeneration {
  readonly id: number;
  readonly child: UtilityProcess;
  readonly rpc: RuntimeRpcPeer<RuntimeHostMethods, AgentRuntimeMethods>;
  readonly spawned: Promise<void>;
  ready: Promise<void> | undefined;
  failure: Error | undefined;
  inspectorUrl: string | undefined;
}

/**
 * Runs Pi in an Electron utility process so agent work cannot block the window's main thread.
 * Catalog persistence and every Electron capability stay in main.
 *
 * If the process is lost, running work fails visibly and nothing is replayed. A new process
 * starts straight away; each session reopens from its file the next time it is used. Repeated
 * losses within a short window stop the restarts so a crashing extension cannot loop.
 */
export class AgentRuntimeProcess {
  private current: RuntimeGeneration | undefined;
  private generations = 0;
  private restarts = 0;
  private stopped: Error | undefined;
  private driverOptions: PiSdkDriverConfig | undefined;
  private disposed = false;
  private readonly restartBudget: RuntimeRestartBudget;
  private readonly handlers: RuntimeRpcHandlers<RuntimeHostMethods>;
  private readonly sessionListeners = new Map<string, SessionSubscription>();
  private readonly loginCallbacks = new Map<string, RuntimeLoginCallbacks>();
  private readonly viewListeners = new Set<(target: SessionRef) => void>();
  private readonly viewCatalogs = new Map<
    string,
    { readonly target: SessionRef; readonly views: readonly DesktopExtensionViewInfo[] }
  >();
  private readonly viewConnections = new Map<string, ViewConnection>();
  private readonly viewSenders = new Map<string, (message: unknown) => void>();

  constructor(private readonly options: ProcessOptions) {
    this.restartBudget = options.restartBudget ?? new RuntimeRestartBudget();
    this.handlers = this.createHandlers();
    // Start the first process before the store is composed so its startup overlaps app startup.
    this.current = this.spawn();
  }

  get diagnostics(): {
    readonly pid?: number;
    readonly inspectorUrl?: string;
    readonly restarts: number;
  } {
    return {
      pid: this.current?.child.pid,
      inspectorUrl: this.current?.inspectorUrl,
      restarts: this.restarts,
    };
  }

  createDriver(options: PiSdkDriverConfig): DesktopSessionDriver {
    if (this.driverOptions) throw new Error("The desktop runtime driver is already composed");
    this.driverOptions = options;
    void this.live().catch(() => undefined);
    const sessionMethods = remoteRuntimeMethods<
      Pick<PiSdkDriver, (typeof SESSION_METHODS)[number]>
    >(SESSION_METHODS, async (method, args) => {
      const generation = await this.live();
      return generation.rpc.call("session", [
        { method, args, preferences: this.preferences(args[0]) },
      ]);
    });
    const runtimeMethods = remoteRuntimeMethods<
      Pick<RuntimeSupervisor, (typeof RUNTIME_METHODS)[number]>
    >(RUNTIME_METHODS, async (method, args) => {
      const generation = await this.live();
      return generation.rpc.call("runtime", [{ method, args, preferences: this.preferences() }]);
    });
    return {
      ...sessionMethods,
      subscribe: (target, listener) => this.subscribe(target, listener),
      runtimeSupervisor: {
        ...runtimeMethods,
        builtinExtensionName: (requestedPath) =>
          RUNTIME_BUILTINS.find((entry) => `<inline:${entry.name}>` === requestedPath)?.name,
        login: async (workspace, providerId, callbacks) => {
          const generation = await this.live();
          const token = randomUUID();
          this.loginCallbacks.set(token, callbacks);
          try {
            return await generation.rpc.call(
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
    listViews: (target) => this.viewCatalogs.get(sessionKey(target))?.views ?? [],
    openConnection: async (input, send) => {
      const generation = await this.live();
      const token = randomUUID();
      this.viewSenders.set(token, send);
      try {
        const connection = await generation.rpc.call("openView", [token, input]);
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
      const generation = await this.live();
      await generation.rpc.call("view", ["receive", [id, senderId, message]]);
    },
    invokeHostAction: async (id, senderId, action) => {
      const generation = await this.live();
      await generation.rpc.call("view", ["invokeHostAction", [id, senderId, action]]);
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
        const generation = await this.live();
        const response = await generation.rpc.call("viewAsset", [url]);
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
      const generation = this.healthy();
      if (generation?.ready) {
        await generation.ready;
        await generation.rpc.call("view", ["dispose", []]);
      }
    },
  };

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const generation = this.current;
    if (!generation) return;
    // A stuck extension must not hold app quit forever. Never retry an unknown-outcome call.
    let timer: NodeJS.Timeout | undefined;
    try {
      if (!generation.failure && generation.ready)
        await Promise.race([
          generation.ready.then(() => generation.rpc.call("shutdown", [])),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5_000);
          }),
        ]);
    } catch {
      /* The process may already be gone. */
    } finally {
      if (timer) clearTimeout(timer);
      generation.rpc.close();
      generation.child.kill();
    }
  }

  private spawn(): RuntimeGeneration {
    const child = utilityProcess.fork(path.join(__dirname, "agent-runtime.js"), [], {
      serviceName: "Pi agent runtime",
      stdio: "pipe",
      ...(this.options.inspectRuntime ? { execArgv: ["--inspect=127.0.0.1:0"] } : {}),
    });
    const rpc = new RuntimeRpcPeer<RuntimeHostMethods, AgentRuntimeMethods>({
      post: (message) => child.postMessage(message),
    });
    const generation: RuntimeGeneration = {
      id: ++this.generations,
      child,
      rpc,
      spawned: new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("exit", (code) =>
          reject(new Error(`The agent runtime exited while starting (exit code ${code}).`)),
        );
      }),
      ready: undefined,
      failure: undefined,
      inspectorUrl: undefined,
    };
    // Startup failures are reported through ready()/lose(); never as unhandled rejections.
    void generation.spawned.catch(() => undefined);
    rpc.setHandlers(this.handlers);
    child.on("message", (message) => rpc.receive(message));
    child.on("error", (_type, location, details) => {
      this.lose(generation, `The agent runtime crashed (${location}: ${details}).`);
    });
    child.on("exit", (code) => {
      this.lose(generation, `The agent runtime stopped unexpectedly (exit code ${code}).`);
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.on("data", (chunk: Buffer) => {
      if (this.options.inspectRuntime && !generation.inspectorUrl) {
        generation.inspectorUrl = /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.exec(chunk.toString())?.[0];
      }
    });
    child.stderr?.pipe(process.stderr);
    return generation;
  }

  /** The initialized runtime, starting a new one if the previous one was lost. */
  private async live(): Promise<RuntimeGeneration> {
    if (this.disposed) throw new Error("The agent runtime is shutting down.");
    if (this.stopped) throw this.stopped;
    const options = this.driverOptions;
    if (!options) throw new Error("The desktop runtime driver is not composed");
    if (!this.current || this.current.failure) this.current = this.spawn();
    const generation = this.current;
    generation.ready ??= generation.spawned
      .then(() =>
        generation.rpc.call("initialize", [
          { ...this.options.init, turnCaptureTimeoutMs: options.turnCaptureTimeoutMs },
        ]),
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.lose(generation, `The agent runtime failed to start: ${message}`);
        throw generation.failure ?? error;
      });
    await generation.ready;
    if (generation.failure) throw generation.failure;
    return generation;
  }

  /** The current runtime only if it is initialized or starting and not lost. */
  private healthy(): RuntimeGeneration | undefined {
    const generation = this.current;
    return generation && !generation.failure && !this.disposed ? generation : undefined;
  }

  private subscribe(target: SessionRef, listener: SessionEventListener): () => void {
    const token = randomUUID();
    const subscription: SessionSubscription = { target, listener, generation: undefined };
    this.sessionListeners.set(token, subscription);
    void this.live()
      .then(async (generation) => {
        if (this.sessionListeners.get(token) !== subscription) return;
        subscription.generation = generation;
        await generation.rpc.call("subscribe", [token, target]);
      })
      .catch((error: unknown) => {
        // A lost runtime already told every listener. Anything else only affects this session:
        // detach it so the next use reopens it, rather than leaving it silently without events.
        if (this.sessionListeners.get(token) !== subscription) return;
        this.sessionListeners.delete(token);
        const message = error instanceof Error ? error.message : String(error);
        this.notify(subscription, AGENT_SESSION_DETACHED, message);
      });
    return () => {
      const entry = this.sessionListeners.get(token);
      this.sessionListeners.delete(token);
      const generation = entry?.generation;
      if (generation && generation === this.healthy())
        void generation.rpc.call("unsubscribe", [token]).catch(() => undefined);
    };
  }

  private lose(generation: RuntimeGeneration, reason: string): void {
    if (generation.failure) return;
    const restartAllowed = !this.disposed && this.restartBudget.recordFailure();
    const message = restartAllowed
      ? `${reason} Running work stopped and nothing was replayed. pi-gui restarted the runtime; send again to continue.`
      : `${reason} It stopped ${this.restartBudget.failuresInWindow} times within a minute, so pi-gui stopped restarting it. A recently added extension may be the cause. Restart pi-gui to try again.`;
    const error = new Error(message);
    Object.assign(error, { code: AGENT_RUNTIME_UNAVAILABLE });
    generation.failure = error;
    generation.rpc.close(error);
    generation.child.kill();
    if (this.disposed || generation !== this.current) return;
    if (!restartAllowed) this.stopped = error;
    for (const connection of [...this.viewConnections.values()]) {
      connection.send({ type: "closed", reason: error.message });
      this.forgetView(connection);
    }
    const targets = [...this.viewCatalogs.values()].map((entry) => entry.target);
    this.viewCatalogs.clear();
    for (const subscription of this.sessionListeners.values())
      this.notify(subscription, AGENT_RUNTIME_UNAVAILABLE, error.message);
    this.sessionListeners.clear();
    for (const target of targets) for (const listener of this.viewListeners) listener(target);
    if (restartAllowed) {
      this.restarts += 1;
      // Start the replacement now so the next action does not wait for it.
      setImmediate(() => void this.live().catch(() => undefined));
    }
  }

  private notify(subscription: SessionSubscription, code: string, message: string): void {
    const event: SessionDriverEvent = {
      type: "runFailed",
      sessionRef: subscription.target,
      timestamp: new Date().toISOString(),
      error: { code, message },
    };
    void Promise.resolve()
      .then(() => subscription.listener(event))
      .catch(() => undefined);
  }

  private createHandlers(): RuntimeRpcHandlers<RuntimeHostMethods> {
    return {
      ...this.options.capabilities,
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
        this.viewCatalogs.set(sessionKey(target), { target, views });
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
    };
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
    const generation = this.healthy();
    if (!generation?.ready) return;
    void generation.ready
      .then(() => generation.rpc.call("view", [method, args]))
      .catch(() => undefined);
  }
  private forgetView(connection: ViewConnection): void {
    this.viewConnections.delete(connection.context.connectionId);
    this.viewSenders.delete(connection.token);
  }
}
