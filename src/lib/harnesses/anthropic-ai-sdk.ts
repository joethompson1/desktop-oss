// Vercel AI SDK provider wrapping our Anthropic transport for the
// orchestrator. The wrapper exists because `@ai-sdk/anthropic` on its own
// doesn't:
//
//   1. Route through our Rust `http_stream` command — bypasses CORS so
//      Anthropic doesn't reject the request as browser-originated.
//   2. Send the full Claude Code CLI fingerprint (User-Agent, x-app,
//      X-Claude-Code-Session-Id, claude-code + oauth beta headers).
//   3. Prepend the `x-anthropic-billing-header: cc_version=…; cc_entrypoint=cli;`
//      line into the system prompt body. The server reads it from there,
//      not from HTTP headers, to attribute the request and avoid the
//      anti-abuse rate limiter.
//
// (1) and (2) are handled at provider construction via `createAnthropic`'s
// `fetch` and `headers` options. (3) is handled by a middleware that
// mutates the system message before it reaches the underlying provider.

import { createAnthropic } from "@ai-sdk/anthropic";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type { LanguageModelV3, LanguageModelV3Prompt } from "@ai-sdk/provider";

import type { HarnessConfig } from "$lib/types/harness";
import { getValidClaudeCodeCredentials } from "./claude-code-auth";
import { nativeFetchAsFetch } from "./native-fetch";
import {
  ANTHROPIC_VERSION,
  buildBillingHeaderLine,
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_CODE_BETA,
  CONTEXT_1M_BETA,
  DEFAULT_MODEL,
  OAUTH_BETA,
  PROMPT_CACHING_BETA,
  SESSION_ID,
} from "./claude-code-fingerprint";

export interface BuildAnthropicModelDeps {
  /** Resolves the API key when `config.authMode === 'api-key'`. */
  getApiKey?: () => Promise<string | undefined>;
}

/**
 * Build a Vercel AI SDK `LanguageModel` for the given Anthropic harness
 * config. Throws when credentials are missing or expired so the caller
 * surfaces a clean error to the user rather than producing a model that
 * silently 401s on first use.
 */
export async function buildAnthropicLanguageModel(
  config: HarnessConfig,
  deps: BuildAnthropicModelDeps = {},
): Promise<LanguageModelV3> {
  const authMode = config.authMode ?? "api-key";

  const headers: Record<string, string> = {
    "anthropic-version": ANTHROPIC_VERSION,
    // Belt-and-braces: if anything ever re-introduces an Origin header,
    // this opt-in stops Anthropic refusing the request outright. Harmless
    // when the request isn't browser-originated.
    "anthropic-dangerous-direct-browser-access": "true",
  };

  let apiKey: string | undefined;
  let authToken: string | undefined;
  const betas: string[] = [];

  if (authMode === "account") {
    // Auto-refreshes via the cached refresh token when the access token
    // has expired — see getValidClaudeCodeCredentials for the full path.
    const creds = await getValidClaudeCodeCredentials();
    if (!creds.hasCredentials || !creds.accessToken) {
      throw new Error(
        "No Claude Code account login found. Run `claude auth login` first, or switch this harness to API key mode.",
      );
    }
    authToken = creds.accessToken;

    headers["x-app"] = "cli";
    headers["User-Agent"] = CLAUDE_CLI_USER_AGENT;
    headers["X-Claude-Code-Session-Id"] = SESSION_ID;
    headers["x-client-app"] = "desktop-oss";

    betas.push(CLAUDE_CODE_BETA, OAUTH_BETA);
  } else {
    apiKey = await deps.getApiKey?.();
    if (!apiKey) {
      throw new Error(
        `No API key configured for harness "${config.name}". Add one in Settings.`,
      );
    }
    betas.push(PROMPT_CACHING_BETA);
  }
  if (config.context1m) betas.push(CONTEXT_1M_BETA);
  headers["anthropic-beta"] = betas.join(",");

  const provider = createAnthropic({
    apiKey,
    authToken,
    headers,
    fetch: nativeFetchAsFetch,
  });

  const baseModel = provider(config.model ?? DEFAULT_MODEL);

  // Billing-header middleware is only needed in account (OAuth) mode —
  // api-key requests are billed directly against the API key holder and
  // don't go through the cc_version attribution path.
  if (authMode !== "account") return baseModel;

  const billingMiddleware: LanguageModelMiddleware = {
    specificationVersion: "v3",
    transformParams: async ({ params }) => ({
      ...params,
      prompt: await prependBillingLineToSystem(params.prompt),
    }),
  };

  return wrapLanguageModel({ model: baseModel, middleware: billingMiddleware });
}

/**
 * Mutate the prompt array so the system message starts with the
 * `x-anthropic-billing-header: …` line. If there is no system message
 * yet, prepend one containing only that line. The line itself depends
 * on the first user message's text — that's how the upstream server
 * recomputes and validates the fingerprint.
 */
async function prependBillingLineToSystem(
  prompt: LanguageModelV3Prompt,
): Promise<LanguageModelV3Prompt> {
  const firstUserText = extractFirstUserText(prompt);
  const billingLine = await buildBillingHeaderLine(firstUserText);

  const sysIdx = prompt.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    const sys = prompt[sysIdx] as { role: "system"; content: string };
    const updated: LanguageModelV3Prompt = [...prompt];
    updated[sysIdx] = {
      ...sys,
      role: "system",
      content: `${billingLine}\n${sys.content}`,
    };
    return updated;
  }
  return [{ role: "system", content: billingLine }, ...prompt];
}

function extractFirstUserText(prompt: LanguageModelV3Prompt): string {
  const firstUser = prompt.find((m) => m.role === "user");
  if (!firstUser) return "";
  const parts = firstUser.content;
  if (!Array.isArray(parts)) return "";
  for (const part of parts) {
    if (part.type === "text") return part.text;
  }
  return "";
}
