// Minimal Server-Sent-Events parser. Yields `{ event, data }` records
// from a fetch response body. Both Anthropic and OpenAI-compatible
// streaming wire formats use SSE with JSON payloads on the data line.

export interface SSERecord {
  event: string | null;
  data: string;
}

/** Permissive subset of Response — accepts both the platform Response and
 *  our `NativeFetchResponse` wrapper. We only need `body.getReader()`. */
export interface SSESource {
  body?: { getReader(): ReadableStreamDefaultReader<Uint8Array> } | null;
}

export async function* parseSSEStream(
  response: SSESource,
): AsyncIterable<SSERecord> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response has no readable body");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event: string | null = null;
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            data += line.slice(5).trimStart();
          }
        }
        if (data.length > 0) yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
