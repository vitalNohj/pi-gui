type Arguments<T> = T extends (...args: infer A) => unknown ? A : never;
type Result<T> = T extends (...args: never[]) => infer R ? Awaited<R> : never;
export type RuntimeRpcHandlers<T> = {
  [K in keyof T]: (
    args: Arguments<T[K]>,
    signal: AbortSignal,
  ) => Result<T[K]> | Promise<Result<T[K]>>;
};

type WireError = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
  readonly holder?: unknown;
};
type Request = {
  readonly kind: "request";
  readonly id: number;
  readonly method: string;
  readonly args: unknown[];
};
type Reply =
  | { readonly kind: "reply"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly kind: "reply"; readonly id: number; readonly ok: false; readonly error: WireError };
type Message = Request | Reply | { readonly kind: "cancel"; readonly id: number };

export interface RuntimeRpcTransport {
  post(message: unknown): void;
}

function encodeError(error: unknown): WireError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
    ...("code" in error && error.code === "SESSION_LEASED" && "holder" in error
      ? { holder: error.holder }
      : {}),
  };
}

function decodeError(value: WireError): Error {
  const error = new Error(value.message);
  error.name = value.name;
  if (value.stack) error.stack = value.stack;
  // Error codes, not process-local prototypes, preserve the store's lease/conflict handling.
  if (value.code) Object.assign(error, { code: value.code });
  if (value.code === "SESSION_LEASED" && value.holder)
    Object.assign(error, { holder: value.holder });
  return error;
}

/**
 * A private, bidirectional request/reply channel between main and its owned utility process.
 * Requests are NOT put in a global serial queue: Stop and host-dialog replies must be able
 * to settle an outstanding prompt. The existing session owners retain event/turn ordering.
 * Only own properties in the supplied method table are callable; no remote object traversal.
 */
export class RuntimeRpcPeer<Local, Remote> {
  private nextId = 1;
  private handlers: RuntimeRpcHandlers<Local> | undefined;
  private failure: Error | undefined;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }
  >();
  private readonly incoming = new Map<number, AbortController>();

  constructor(private readonly transport: RuntimeRpcTransport) {}

  setHandlers(handlers: RuntimeRpcHandlers<Local>): void {
    if (this.handlers) throw new Error("Runtime RPC handlers are already installed");
    this.handlers = handlers;
  }

  call<K extends keyof Remote & string>(
    method: K,
    args: Arguments<Remote[K]>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<Remote[K]>> {
    if (this.failure) return Promise.reject(this.failure);
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(new Error("Runtime request was cancelled"));
    if (this.pending.size >= 4096) {
      return Promise.reject(new Error("Too many pending agent runtime requests"));
    }
    const id = this.nextId++;
    return new Promise<Result<Remote[K]>>((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", cancel);
        reject(new Error("Runtime request was cancelled"));
        this.post({ kind: "cancel", id });
      };
      this.pending.set(id, {
        resolve: (value) => resolve(value as Result<Remote[K]>),
        reject,
        cleanup: () => signal?.removeEventListener("abort", cancel),
      });
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        this.transport.post({ kind: "request", id, method, args } satisfies Request);
      } catch (error) {
        this.pending.delete(id);
        signal?.removeEventListener("abort", cancel);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Incoming requests are allowed to overlap; each receives its own cancellation signal. */
  receive(raw: unknown): void {
    if (this.failure || !raw || typeof raw !== "object") return;
    const message = raw as Message;
    if (!Number.isSafeInteger(message.id) || message.id < 1) return;
    if (message.kind === "reply") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.cleanup();
      if (message.ok) pending.resolve(message.value);
      else pending.reject(decodeError(message.error));
      return;
    }
    if (message.kind === "cancel") {
      this.incoming.get(message.id)?.abort();
      return;
    }
    if (message.kind !== "request" || !Array.isArray(message.args)) return;
    const handlers = this.handlers;
    const handler =
      handlers && Object.hasOwn(handlers, message.method)
        ? handlers[message.method as keyof Local]
        : undefined;
    if (typeof handler !== "function") {
      this.post({
        kind: "reply",
        id: message.id,
        ok: false,
        error: { name: "Error", message: `Unknown agent runtime method: ${message.method}` },
      });
      return;
    }
    const controller = new AbortController();
    this.incoming.set(message.id, controller);
    // Cancellation is out of band; it cannot become an SDK method's optional argument.
    void Promise.resolve()
      .then(() =>
        (handler as (args: unknown[], signal: AbortSignal) => unknown)(
          message.args,
          controller.signal,
        ),
      )
      .then(
        (value) => this.post({ kind: "reply", id: message.id, ok: true, value }),
        (error: unknown) =>
          this.post({ kind: "reply", id: message.id, ok: false, error: encodeError(error) }),
      )
      .finally(() => this.incoming.delete(message.id));
  }

  close(error = new Error("Agent runtime connection closed")): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    for (const controller of this.incoming.values()) controller.abort();
    this.incoming.clear();
  }

  private post(message: Message): void {
    if (this.failure) return;
    try {
      this.transport.post(message);
    } catch (error) {
      if (message.kind === "reply" && message.ok) {
        // A non-cloneable extension result must reject its caller, not leave it pending
        // forever or tear down unrelated in-flight requests on an otherwise good port.
        try {
          this.transport.post({
            kind: "reply",
            id: message.id,
            ok: false,
            error: encodeError(error),
          } satisfies Reply);
          return;
        } catch {
          /* The transport itself is gone. */
        }
      }
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** Bind an explicit allowlist of instance methods without exposing the instance over IPC. */
export async function invokeRuntimeMethod<T>(
  owner: T,
  names: readonly (keyof T & string)[],
  name: string,
  args: unknown[],
): Promise<unknown> {
  if (!names.includes(name as keyof T & string)) throw new Error(`Unknown runtime method: ${name}`);
  const method = owner[name as keyof T];
  if (typeof method !== "function") throw new Error(`Not a runtime method: ${name}`);
  return method.apply(owner, args);
}

/** Typed stubs for the same explicit method list, not an arbitrary property Proxy. */
export function remoteRuntimeMethods<T>(
  names: readonly (keyof T & string)[],
  invoke: (name: string, args: unknown[]) => Promise<unknown>,
): {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
} {
  return Object.fromEntries(
    names.map((name) => [name, (...args: unknown[]) => invoke(name, args)]),
  ) as {
    [K in keyof T]: T[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Awaited<R>>
      : never;
  };
}
