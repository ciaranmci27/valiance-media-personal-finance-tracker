/**
 * Cancel the reader, not the transport. Navigation must not reject a fetch that
 * browser observers may also be consuming. The response is still drained, but
 * an abandoned screen receives no data and its promise settles immediately.
 */
export function accountingReadJson<T>(
  url: string,
  signal?: AbortSignal,
): Promise<T> {
  const cancelled = () => new DOMException("Request cancelled", "AbortError");
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (deliver: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      deliver();
    };
    const cancel = () => finish(() => reject(cancelled()));
    signal?.addEventListener("abort", cancel, { once: true });
    void (async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        const result = await response.json();
        if (!response.ok)
          throw new Error(result?.error ?? "Unable to load accounting data.");
        finish(() => resolve(result as T));
      } catch (error) {
        // Always consume transport/body failures, even after reader cancellation.
        finish(() => reject(error));
      }
    })();
  });
}
