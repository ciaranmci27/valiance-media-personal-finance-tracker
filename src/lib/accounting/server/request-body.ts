import "server-only";
/** Enforce limits while reading, including requests without Content-Length. */
export async function boundedBytes(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > limit) throw new Error("Request exceeds the supported size.");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Request exceeds the supported size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function boundedForm(
  request: Request,
  limit: number,
): Promise<FormData> {
  const bytes = await boundedBytes(request, limit);
  return new Response(bytes as BodyInit, {
    headers: { "content-type": request.headers.get("content-type") ?? "" },
  }).formData();
}
