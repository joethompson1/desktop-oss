// A `fetch`-shaped wrapper around the Rust `http_stream` command.
//
// Why this exists: Anthropic (and possibly other LLM APIs) classify
// requests as "CORS" if the client forwards an Origin header. Some
// organisations disable CORS access at the policy level, which makes
// browser-originated requests fail with 401 — *even* when the
// `anthropic-dangerous-direct-browser-access` opt-in header is set.
//
// The Tauri webview's fetch (and `@tauri-apps/plugin-http`'s fetch in v2)
// both forward Origin. We work around this by routing through a custom
// Rust command that uses reqwest directly — no Origin header, no CORS
// classification, no org-level denial.
//
// The wrapper preserves the streaming surface area the harnesses need:
//   - `response.ok`, `response.status`
//   - `response.text()` for buffering
//   - `response.body.getReader()` for SSE parsing
// so the call sites can swap `fetch` import without touching any code.

import { Channel, invoke } from "@tauri-apps/api/core";

interface HttpStreamEvent {
  event: "headers" | "data" | "end" | "error";
  status?: number;
  statusText?: string;
  chunk?: string;
  error?: string;
}

export interface NativeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface NativeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
  readonly body: {
    getReader(): ReadableStreamDefaultReader<Uint8Array>;
  };
}

export async function nativeFetch(
  url: string,
  init: NativeFetchInit = {},
): Promise<NativeFetchResponse> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = init.headers ?? {};
  const body = init.body;

  const channel = new Channel<HttpStreamEvent>();
  const encoder = new TextEncoder();

  let status = 0;
  let statusText = "";
  let headersSeen = false;
  let queue: Uint8Array[] = [];
  let done = false;
  let errorMsg: string | null = null;
  const waiters: Array<() => void> = [];

  function wake() {
    while (waiters.length > 0) waiters.shift()!();
  }

  channel.onmessage = (msg) => {
    if (msg.event === "headers") {
      status = msg.status ?? 0;
      statusText = msg.statusText ?? "";
      headersSeen = true;
      // eslint-disable-next-line no-console
      console.debug("[nativeFetch] headers", { url, status, statusText });
    } else if (msg.event === "data" && typeof msg.chunk === "string") {
      queue.push(encoder.encode(msg.chunk));
    } else if (msg.event === "end") {
      done = true;
      // eslint-disable-next-line no-console
      console.debug("[nativeFetch] end", { url });
    } else if (msg.event === "error") {
      errorMsg = msg.error ?? "stream error";
      done = true;
      // eslint-disable-next-line no-console
      console.error("[nativeFetch] error", { url, errorMsg });
    }
    wake();
  };

  // eslint-disable-next-line no-console
  console.debug("[nativeFetch] →", method, url, {
    headerKeys: Object.keys(headers),
    bodyBytes: body?.length ?? 0,
  });

  // Kick off the request. The promise resolves when Rust finishes the
  // stream (or rejects on send failure); we drive readiness off the
  // channel events because we want to surface the response *before* the
  // body has finished arriving.
  const invokePromise = invoke<void>("http_stream", {
    method,
    url,
    headers,
    body,
    onEvent: channel,
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[nativeFetch] invoke rejected", err);
    if (!errorMsg) errorMsg = err instanceof Error ? err.message : String(err);
    done = true;
    wake();
  });

  // Abort wiring — best-effort. The Rust command doesn't currently
  // observe a cancellation signal, but we at least stop draining the
  // channel and reject any pending reads.
  if (init.signal) {
    if (init.signal.aborted) {
      errorMsg = "aborted";
      done = true;
    }
    init.signal.addEventListener("abort", () => {
      errorMsg = "aborted";
      done = true;
      wake();
    });
  }

  // Wait for either the headers event or a fatal error before returning.
  while (!headersSeen && !done) {
    await new Promise<void>((r) => waiters.push(r));
  }

  if (!headersSeen && errorMsg) {
    throw new Error(errorMsg);
  }

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        const tryPump = () => {
          if (queue.length > 0) {
            for (const chunk of queue) controller.enqueue(chunk);
            queue = [];
            resolve();
            return;
          }
          if (done) {
            if (errorMsg) controller.error(new Error(errorMsg));
            else controller.close();
            resolve();
            return;
          }
          waiters.push(tryPump);
        };
        tryPump();
      });
    },
    cancel() {
      // No way to cancel the in-flight Rust task right now, but flushing
      // the queue prevents memory bloat.
      queue = [];
    },
  });

  let textCache: Promise<string> | null = null;

  const response: NativeFetchResponse = {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    body: { getReader: () => stream.getReader() },
    text() {
      if (!textCache) {
        textCache = (async () => {
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          let result = "";
          while (true) {
            const { done: d, value } = await reader.read();
            if (d) break;
            if (value) result += decoder.decode(value, { stream: true });
          }
          result += decoder.decode();
          return result;
        })();
      }
      return textCache;
    },
  };

  // Keep the promise alive so unhandled rejection doesn't blow up; any
  // post-headers error is delivered through the stream above.
  void invokePromise;

  return response;
}

/**
 * fetch-API-shaped wrapper around `nativeFetch`. The Vercel AI SDK's
 * provider `fetch` option expects a function with the standard browser
 * `fetch` signature returning a real `Response`. Our `nativeFetch`
 * returns a narrower `NativeFetchResponse`, so this wrapper rebuilds
 * a proper `Response` over the same Rust-side stream.
 */
export const nativeFetchAsFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => (headers[k] = v));
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) headers[k] = v;
    } else {
      Object.assign(headers, init.headers);
    }
  }

  let body: string | undefined;
  if (init?.body != null) {
    body =
      typeof init.body === "string"
        ? init.body
        : await new Response(init.body as BodyInit).text();
  }

  const native = await nativeFetch(url, {
    method: init?.method ?? "GET",
    headers,
    body,
    signal: init?.signal ?? undefined,
  });

  const reader = native.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else if (value) controller.enqueue(value);
    },
  });

  return new Response(stream, {
    status: native.status,
    statusText: native.statusText,
  });
};
