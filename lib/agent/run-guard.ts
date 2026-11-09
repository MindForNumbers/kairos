/**
 * One agent run at a time per process, whoever starts it (Run agent button, chat request).
 * Taken synchronously, before any await, so simultaneous requests can't both get in.
 */
export class RunBusyError extends Error {
  constructor() {
    super("An agent run is already in progress");
    this.name = "RunBusyError";
  }
}

let busy = false;

export async function withRunLock<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw new RunBusyError();
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}
