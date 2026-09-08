import type { EventEmitter } from "node:events";

export type ShutdownSignal = "SIGTERM" | "SIGINT";

interface ShutdownHooks {
  drain?: (signal: ShutdownSignal) => void | Promise<void>;
  close: () => void | Promise<void>;
}

interface SignalSource {
  on(event: ShutdownSignal, listener: () => void): EventEmitter | NodeJS.Process;
  off(event: ShutdownSignal, listener: () => void): EventEmitter | NodeJS.Process;
}

interface SignalHandlerOptions {
  source?: SignalSource;
  onError?: (error: unknown) => void;
}

export class ShutdownCoordinator {
  private readonly abortController = new AbortController();
  private shutdownPromise: Promise<void> | null = null;
  private shutdownReason: ShutdownSignal | null = null;

  constructor(private readonly hooks: ShutdownHooks) {}

  get requested(): boolean {
    return this.shutdownPromise != null;
  }

  get reason(): ShutdownSignal | null {
    return this.shutdownReason;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get done(): Promise<void> {
    return this.shutdownPromise ?? Promise.resolve();
  }

  request(signal: ShutdownSignal): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownReason = signal;
      this.abortController.abort(signal);
      this.shutdownPromise = this.run(signal);
    }
    return this.shutdownPromise;
  }

  private async run(signal: ShutdownSignal): Promise<void> {
    let failure: unknown;
    try {
      await this.hooks.drain?.(signal);
    } catch (error) {
      failure = error;
    }

    try {
      await this.hooks.close();
    } catch (error) {
      failure = failure == null ? error : new AggregateError([failure, error], "Shutdown failed");
    }

    if (failure != null) throw failure;
  }
}

export function installProcessShutdownHandlers(
  coordinator: ShutdownCoordinator,
  options: SignalHandlerOptions = {},
): () => void {
  const source = options.source ?? process;
  const onError = options.onError ?? ((error: unknown) => {
    console.error(`[shutdown] ${String(error instanceof Error ? error.message : error)}`);
    process.exitCode = 1;
  });
  const handlers = new Map<ShutdownSignal, () => void>();

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const handler = () => {
      void coordinator.request(signal).catch(onError);
    };
    handlers.set(signal, handler);
    source.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) source.off(signal, handler);
  };
}

export function interruptibleDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<"elapsed" | "aborted"> {
  if (signal.aborted) return Promise.resolve("aborted");
  if (milliseconds <= 0) return Promise.resolve("elapsed");

  return new Promise((resolve) => {
    const finish = (result: "elapsed" | "aborted") => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish("aborted");
    const timer = setTimeout(() => finish("elapsed"), milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
