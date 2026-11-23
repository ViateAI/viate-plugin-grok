import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createPluginLogger, parseOpenAIChatUsage, parseOpenAIResponsesUsage, type ProviderConnection } from "@viateai/sdk";
import {
  chatCompletions,
  listModels,
  normalizeCredentials,
  parseCredentials,
  pollDeviceOAuth,
  responses,
  startDeviceOAuth,
  keepalive,
} from "./index.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("grok plugin", () => {
  it("normalizes auth.json and token paste", () => {
    const token = jwt({ email: "grok@example.com", sub: "user-1", exp: Math.floor(Date.now() / 1_000) + 3_600 });
    const normalized = normalizeCredentials(parseCredentials(JSON.stringify({
      "https://auth.x.ai::client": { key: token, refresh_token: "refresh" },
    })));
    assert.equal(normalized.displayLabel, "grok@example.com");
    assert.equal(
      normalized.credentials && typeof normalized.credentials === "object" && "accessToken" in normalized.credentials
        ? normalized.credentials.accessToken
        : undefined,
      token,
    );
    assert.deepEqual(normalizeCredentials("raw-token").credentials, { accessToken: "raw-token" });
  });

  it("uses the embedded public client id for device authorization and polling", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("client_id"), "b1a00492-073a-47ea-816f-4c329264a828");
      if (url.endsWith("/device/code")) {
        return Response.json({
          device_code: "device",
          user_code: "GROK-CODE",
          verification_uri: "https://auth.x.ai/device",
          interval: 1,
        });
      }
      return Response.json({ access_token: "access", refresh_token: "refresh" });
    };
    const started = await startDeviceOAuth();
    assert.equal(started.type, "device_code");
    const polled = await pollDeviceOAuth({ session: started.session });
    assert.equal(polled.type, "complete");
    assert.deepEqual(urls, [
      "https://auth.x.ai/oauth2/device/code",
      "https://auth.x.ai/oauth2/token",
    ]);
  });

  it("records upstream OAuth error on keepalive refresh 400", async () => {
    const writes: Array<{ level: string; fields?: Record<string, unknown>; message: string }> = [];
    globalThis.fetch = async () => Response.json(
      { error: "invalid_grant", error_description: "Refresh token has been revoked" },
      { status: 400 },
    );
    const result = await keepalive({
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      signal: new AbortController().signal,
      connectionId: "c1",
      reason: "timer",
      log: createPluginLogger((level, fields, message) => {
        writes.push({ level, fields, message });
      }),
    });
    assert.equal(result.status, "needs_reauth");
    assert.equal(
      result.error,
      "Grok token refresh failed (400): Refresh token has been revoked",
    );
    assert.deepEqual(writes, [{
      level: "warn",
      fields: {
        status: "needs_reauth",
        error: "Grok token refresh failed (400): Refresh token has been revoked",
        httpStatus: 400,
      },
      message: "token refresh failed",
    }]);
  });

  it("converts chat requests for the Grok Responses proxy", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    let headers: Headers | undefined;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://cli-chat-proxy.grok.com/v1/responses");
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      headers = new Headers(init?.headers);
      return Response.json({
        id: "response-1",
        model: "grok-build",
        output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
      });
    };
    const result = await chatCompletions(
      { body: { model: "grok-build", messages: [{ role: "user", content: "hi" }] }, headers: {} },
      connection({ accessToken: "access", email: "grok@example.com" }),
    );
    assert.equal(upstreamBody?.messages, undefined);
    assert.equal(Array.isArray(upstreamBody?.input), true);
    assert.equal(headers?.get("x-xai-token-auth"), "xai-grok-cli");
    assert.equal(headers?.get("x-grok-client-version"), "1.0.46");
    assert.equal(headers?.get("user-agent"), "grok-shell/1.0.46");
    assert.equal(headers?.get("x-grok-client-identifier"), "grok-shell");
    const returned = await new Response(result.body).json() as { choices: Array<{ message: { content: string } }> };
    assert.equal(returned.choices[0]?.message.content, "hello");
    assert.equal(result.parseUsage, parseOpenAIChatUsage);
  });

  it("rewrites chat text parts to Responses content types", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "response-1",
        model: "grok-4.7",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      });
    };
    await chatCompletions(
      {
        body: {
          model: "grok-4.7",
          messages: [
            { role: "developer", content: "rules" },
            { role: "user", content: [{ type: "text", text: "hello" }] },
            { role: "assistant", content: [{ type: "text", text: "prior" }] },
          ],
        },
        headers: {},
      },
      connection({ accessToken: "access", email: "grok@example.com" }),
    );
    assert.deepEqual(upstreamBody?.input, [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "prior" }] },
    ]);
  });

  it("converts assistant tool calls and tool results into Responses input", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "response-1",
        model: "grok-4.7",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      });
    };
    await chatCompletions(
      {
        body: {
          model: "grok-4.7",
          messages: [
            {
              role: "assistant",
              content: "看一下",
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "Read", arguments: "{\"path\":\"a.ts\"}" },
              }],
            },
            { role: "tool", tool_call_id: "call_1", content: "file text" },
            {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_2",
                type: "function",
                function: { name: "Grep", arguments: "{\"pattern\":\"x\"}" },
              }],
            },
          ],
        },
        headers: {},
      },
      connection({ accessToken: "access", email: "grok@example.com" }),
    );
    assert.deepEqual(upstreamBody?.input, [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "看一下" }] },
      { type: "function_call", call_id: "call_1", name: "Read", arguments: "{\"path\":\"a.ts\"}" },
      { type: "function_call_output", call_id: "call_1", output: "file text" },
      { type: "function_call", call_id: "call_2", name: "Grep", arguments: "{\"pattern\":\"x\"}" },
    ]);
  });

  it("translates streamed function calls into chat tool call chunks", async () => {
    const events = [
      { type: "response.created", response: { id: "resp_1", model: "grok-4.7", created_at: 1_700_000_000 } },
      { type: "response.output_text.delta", delta: "继续" },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"path\":" },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "\"a.ts\"}" },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        name: "Read",
        arguments: "{\"path\":\"a.ts\"}",
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "grok-4.7",
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            total_tokens: 14,
            input_tokens_details: { cached_tokens: 2 },
          },
          output: [
            { type: "message", content: [{ type: "output_text", text: "继续" }] },
            { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read", arguments: "{\"path\":\"a.ts\"}" },
            { type: "function_call", id: "fc_2", call_id: "call_2", name: "Grep", arguments: "{\"pattern\":\"x\"}" },
          ],
        },
      },
    ];
    globalThis.fetch = async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
    const result = await chatCompletions(
      { body: { model: "grok-4.7", stream: true, messages: [{ role: "user", content: "继续" }] }, headers: {} },
      connection({ accessToken: "access", email: "grok@example.com" }),
    );
    const parsed = parseSse(await new Response(result.body).text());
    assert.deepEqual(parsed.map((chunk) => chunk.choices[0]), [
      { index: 0, delta: { role: "assistant", content: "继续" }, finish_reason: null },
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "" } }] },
        finish_reason: null,
      },
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] },
        finish_reason: null,
      },
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: "\"a.ts\"}" } }] },
        finish_reason: null,
      },
      {
        index: 0,
        delta: {
          tool_calls: [{
            index: 1,
            id: "call_2",
            type: "function",
            function: { name: "Grep", arguments: "{\"pattern\":\"x\"}" },
          }],
        },
        finish_reason: null,
      },
      { index: 0, delta: {}, finish_reason: "tool_calls" },
    ]);
    assert.equal(new Set(parsed.map((chunk) => chunk.id)).size, 1);
    assert.equal(parsed[0]?.id, "chatcmpl-resp_1");
    assert.equal(parsed[0]?.created, 1_700_000_000);
    assert.deepEqual(parsed.at(-1)?.usage, {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      prompt_tokens_details: { cached_tokens: 2 },
    });
    assert.equal(result.parseUsage?.(parsed.map((chunk) => chunk))?.inputTokens, 10);
  });

  it("keeps a text-only stream on one completion id and finish_reason stop", async () => {
    const events = [
      { type: "response.created", response: { id: "resp_text", model: "grok-4.7" } },
      { type: "response.output_text.delta", delta: "hello" },
      {
        type: "response.completed",
        response: {
          id: "resp_text",
          model: "grok-4.7",
          output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
        },
      },
    ];
    globalThis.fetch = async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
    const result = await chatCompletions(
      { body: { model: "grok-4.7", stream: true, messages: [{ role: "user", content: "hi" }] }, headers: {} },
      connection({ accessToken: "access", email: "grok@example.com" }),
    );
    const parsed = parseSse(await new Response(result.body).text());
    assert.deepEqual(parsed.map((chunk) => chunk.choices[0]?.delta), [
      { role: "assistant", content: "hello" },
      {},
    ]);
    assert.equal(parsed.at(-1)?.choices[0]?.finish_reason, "stop");
    assert.equal(parsed[0]?.id, parsed[1]?.id);
    assert.equal(parsed[0]?.id, "chatcmpl-resp_text");
  });

  it("returns tool calls from a non-streaming Responses payload", async () => {
    globalThis.fetch = async () => Response.json({
      id: "resp_json",
      model: "grok-4.7",
      usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } },
      output: [
        { type: "message", content: [{ type: "output_text", text: "继续" }] },
        { type: "function_call", call_id: "call_1", name: "Read", arguments: "{\"path\":\"a.ts\"}" },
      ],
    });
    const result = await chatCompletions(
      { body: { model: "grok-4.7", messages: [{ role: "user", content: "继续" }] }, headers: {} },
      connection({ accessToken: "access", email: "grok@example.com" }),
    );
    const returned = await new Response(result.body).json() as {
      choices: Array<{ finish_reason: string; message: { content: string; tool_calls: unknown[] } }>;
      usage: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details: { cached_tokens: number } };
    };
    assert.equal(returned.choices[0]?.finish_reason, "tool_calls");
    assert.equal(returned.choices[0]?.message.content, "继续");
    assert.deepEqual(returned.choices[0]?.message.tool_calls, [{
      id: "call_1",
      type: "function",
      function: { name: "Read", arguments: "{\"path\":\"a.ts\"}" },
    }]);
    assert.deepEqual(returned.usage, {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
      prompt_tokens_details: { cached_tokens: 1 },
    });
  });

  it("passes Responses requests through without chat conversion", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://cli-chat-proxy.grok.com/v1/responses");
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ id: "resp_1", object: "response", output: [] });
    };
    const result = await responses(
      { body: { model: "grok-build", input: "hi", stream: false }, headers: {} },
      connection({ accessToken: "access", email: "grok@example.com" }),
    );
    assert.equal(upstreamBody?.input, "hi");
    assert.equal(upstreamBody?.messages, undefined);
    const returned = await new Response(result.body).json() as { id: string };
    assert.equal(returned.id, "resp_1");
    assert.equal(result.parseUsage, parseOpenAIResponsesUsage);
  });

  it("returns a typed model list from the Grok models endpoint", async () => {
    let upstreamUrl = "";
    globalThis.fetch = async (input) => {
      upstreamUrl = String(input);
      return Response.json({
        object: "list",
        data: [{ id: "grok-4", owned_by: "xai" }],
      });
    };
    const result = await listModels(
      { headers: {} },
      connection({ accessToken: "access", email: "grok@example.com" }),
    );
    assert.equal(upstreamUrl, "https://cli-chat-proxy.grok.com/v1/models");
    assert.deepEqual(result, {
      object: "list",
      data: [{ id: "grok-4", object: "model", owned_by: "xai" }],
    });
  });
});

function connection(credentials: unknown): ProviderConnection {
  return { connectionId: "c1", providerId: "grok", credentials };
}

function parseSse(body: string): Array<{
  id?: string;
  created?: number;
  choices: Array<{ index?: number; delta?: Record<string, unknown>; finish_reason?: string | null }>;
  usage?: Record<string, unknown>;
}> {
  return body.split("\n\n").flatMap((event) => {
    const data = event.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data) as {
      id?: string;
      created?: number;
      choices: Array<{ index?: number; delta?: Record<string, unknown>; finish_reason?: string | null }>;
      usage?: Record<string, unknown>;
    }];
  });
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}
