/** Race an operation against cancellation, including injected transports that ignore signals. */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}
