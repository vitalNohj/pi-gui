import { expect, test } from "@playwright/test";
import { RuntimeRpcPeer, invokeRuntimeMethod } from "../../electron/runtime/runtime-rpc";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function connected<Main, Runtime>() {
  const main = new RuntimeRpcPeer<Main, Runtime>({
    post: (message) => {
      const copy = structuredClone(message);
      queueMicrotask(() => runtime.receive(copy));
    },
  });
  const runtime = new RuntimeRpcPeer<Runtime, Main>({
    post: (message) => {
      const copy = structuredClone(message);
      queueMicrotask(() => main.receive(copy));
    },
  });
  return { main, runtime };
}

test("Stop replies while the prompt remains outstanding, without serializing all requests", async () => {
  interface Runtime {
    prompt(): Promise<void>;
    stop(): string;
  }
  const { main, runtime } = connected<Record<string, never>, Runtime>();
  const started = deferred();
  const finish = deferred();
  let promptSettled = false;
  runtime.setHandlers({
    prompt: async () => {
      started.resolve();
      await finish.promise;
    },
    stop: () => "stopped",
  });
  const prompt = main.call("prompt", []).then(() => {
    promptSettled = true;
  });
  await started.promise;
  expect(await main.call("stop", [])).toBe("stopped");
  expect(promptSettled).toBe(false);
  finish.resolve();
  await prompt;
  main.close();
  runtime.close();
});

test("a host callback can call back into the runtime without deadlocking", async () => {
  interface Main {
    hostAction(): Promise<string>;
  }
  interface Runtime {
    prompt(): Promise<string>;
    status(): string;
  }
  const { main, runtime } = connected<Main, Runtime>();
  main.setHandlers({ hostAction: () => main.call("status", []) });
  runtime.setHandlers({ prompt: () => runtime.call("hostAction", []), status: () => "running" });
  expect(await main.call("prompt", [])).toBe("running");
  main.close();
  runtime.close();
});

test("ordered events retain listener backpressure across the boundary", async () => {
  interface Main {
    event(value: number): Promise<void>;
  }
  interface Runtime {
    emit(): Promise<void>;
  }
  const { main, runtime } = connected<Main, Runtime>();
  const seen: number[] = [];
  const first = deferred();
  const release = deferred();
  main.setHandlers({
    event: async ([value]) => {
      seen.push(value);
      if (value === 1) {
        first.resolve();
        await release.promise;
      }
    },
  });
  runtime.setHandlers({
    emit: async () => {
      await runtime.call("event", [1]);
      await runtime.call("event", [2]);
    },
  });
  const emit = main.call("emit", []);
  await first.promise;
  expect(seen).toEqual([1]);
  release.resolve();
  await emit;
  expect(seen).toEqual([1, 2]);
  main.close();
  runtime.close();
});

test("cancellation propagates through an outstanding nested host callback", async () => {
  interface Main {
    capture(): Promise<void>;
  }
  interface Runtime {
    prompt(): Promise<void>;
    ping(): string;
  }
  const { main, runtime } = connected<Main, Runtime>();
  const started = deferred();
  const aborted = deferred();
  main.setHandlers({
    capture: (_args, signal) =>
      new Promise<void>((resolve) => {
        started.resolve();
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            resolve();
          },
          { once: true },
        );
      }),
  });
  runtime.setHandlers({
    prompt: (_args, signal) => runtime.call("capture", [], { signal }),
    ping: () => "channel still responds",
  });
  const controller = new AbortController();
  const prompt = main.call("prompt", [], { signal: controller.signal });
  await started.promise;
  controller.abort();
  await expect(prompt).rejects.toThrow("Runtime request was cancelled");
  await aborted.promise;
  expect(await main.call("ping", [])).toBe("channel still responds");
  main.close();
  runtime.close();
});

test("out-of-band cancellation never fills an SDK method's omitted optional argument", async () => {
  interface Runtime {
    invoke(path: string): Promise<unknown>;
  }
  const { main, runtime } = connected<Record<string, never>, Runtime>();
  const owner = {
    inspect(_path: string, options?: { enabled: boolean }) {
      return options;
    },
  };
  runtime.setHandlers({
    invoke: (args) => invokeRuntimeMethod(owner, ["inspect"], "inspect", args),
  });
  expect(await main.call("invoke", ["workspace"])).toBeUndefined();
  main.close();
  runtime.close();
});

test("only allowlisted own methods can be dispatched", async () => {
  interface Runtime {
    invoke(method: string): Promise<unknown>;
  }
  const { main, runtime } = connected<Record<string, never>, Runtime>();
  runtime.setHandlers({
    invoke: ([method]) => invokeRuntimeMethod({ safe: () => "ok" }, ["safe"], method, []),
  });
  expect(await main.call("invoke", ["safe"])).toBe("ok");
  await expect(main.call("invoke", ["constructor"])).rejects.toThrow(
    "Unknown runtime method: constructor",
  );
  await expect(main.call("invoke", ["toString"])).rejects.toThrow(
    "Unknown runtime method: toString",
  );
  main.close();
  runtime.close();
});

test("session lease conflicts preserve the error name, code, holder, and message", async () => {
  interface Runtime {
    open(): void;
  }
  const { main, runtime } = connected<Record<string, never>, Runtime>();
  const holder = {
    pid: 123,
    hostname: "test-host",
    startedAt: "2026-01-01T00:00:00.000Z",
    surface: "pi-gui",
    token: "test-token",
  };
  const original = Object.assign(new Error("Session is held by another pi instance"), {
    name: "SessionLeasedError",
    code: "SESSION_LEASED",
    holder,
  });
  runtime.setHandlers({
    open: () => {
      throw original;
    },
  });
  const error = await main.call("open", []).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    name: "SessionLeasedError",
    code: "SESSION_LEASED",
    holder,
    message: original.message,
  });
  main.close();
  runtime.close();
});

test("process loss rejects pending and future requests without replaying work", async () => {
  interface Runtime {
    prompt(): Promise<void>;
  }
  const { main, runtime } = connected<Record<string, never>, Runtime>();
  const started = deferred();
  const finish = deferred();
  let executions = 0;
  runtime.setHandlers({
    prompt: async () => {
      executions++;
      started.resolve();
      await finish.promise;
    },
  });
  const prompt = main.call("prompt", []);
  await started.promise;
  main.close(new Error("runtime exited"));
  await expect(prompt).rejects.toThrow("runtime exited");
  await expect(main.call("prompt", [])).rejects.toThrow("runtime exited");
  expect(executions).toBe(1);
  finish.resolve();
  runtime.close();
});

test("an uncloneable result rejects its caller and leaves the channel usable", async () => {
  interface Runtime {
    result(): unknown;
    ping(): string;
  }
  const { main, runtime } = connected<Record<string, never>, Runtime>();
  runtime.setHandlers({ result: () => () => undefined, ping: () => "ready" });
  await expect(main.call("result", [])).rejects.toThrow(/clone/);
  expect(await main.call("ping", [])).toBe("ready");
  main.close();
  runtime.close();
});

test("an uncloneable argument rejects its request without poisoning later requests", async () => {
  interface Runtime {
    echo(value: unknown): unknown;
  }
  const { main, runtime } = connected<Record<string, never>, Runtime>();
  runtime.setHandlers({ echo: ([value]) => value });
  await expect(main.call("echo", [() => undefined])).rejects.toThrow();
  expect(await main.call("echo", [{ scheduleFields: { time: "09:00" } }])).toEqual({
    scheduleFields: { time: "09:00" },
  });
  main.close();
  runtime.close();
});
