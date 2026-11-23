import {
  parseOpenAIChatUsage,
  parseOpenAIResponsesUsage,
  toModelList,
  type CredentialsWrite,
  type HttpExchange,
  type JsonGetRequest,
  type JsonPostRequest,
  type KeepaliveInput,
  type KeepaliveResult,
  type ModelList,
  type OAuthPollResult,
  type OAuthStartResult,
  type PluginContext,
  type ProviderConnection,
  type ViatePlugin,
} from "@viateai/sdk";

const PROVIDER_ID = "grok";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const AUTH_BASE_URL = "https://auth.x.ai";
const DEVICE_CODE_URL = `${AUTH_BASE_URL}/oauth2/device/code`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth2/token`;
const PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
// cli-chat-proxy rejects x-grok-client-version below 1.0.13 with HTTP 426.
// Pin the current stable channel (https://x.ai/cli/stable), not the floor.
const GROK_CLIENT_VERSION = "1.0.46";
const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write",
].join(" ");

type GrokCredentials = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  email?: string;
  userId?: string;
  expiresAt?: string;
};

type DeviceSession = { deviceCode: string };

export const plugin: ViatePlugin = {
  id: PROVIDER_ID,
  register(ctx: PluginContext) {
    ctx.registerProvider({
      id: PROVIDER_ID,
      credentialsForm: [{ key: "token", label: "Access token", kind: "secret" }],
      parseCredentials,
      normalizeCredentials,
      startOAuth: startDeviceOAuth,
      pollOAuth: pollDeviceOAuth,
      keepalive,
      chatCompletions,
      listModels,
      responses,
    });
  },
};

export default plugin;

export function parseCredentials(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Grok auth.json or token is required");
  }
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as unknown;
  }
  return trimmed;
}

export function normalizeCredentials(input: unknown): CredentialsWrite {
  const outer = recordValue(input) ?? {};
  let source = outer;
  if (typeof input !== "string" && !stringValue(outer.access_token) && !stringValue(outer.accessToken)) {
    const authEntry = Object.values(outer).find((entry) => {
      const record = recordValue(entry);
      return Boolean(stringValue(record?.key));
    });
    source = recordValue(authEntry) ?? outer;
  }
  const accessToken = firstString(
    typeof input === "string" ? input.trim() : undefined,
    stringValue(source.key),
    stringValue(source.access_token),
    stringValue(source.accessToken),
    stringValue(source.token),
  );
  if (!accessToken) {
    throw new Error("Grok credentials contain no access token");
  }
  const refreshToken = firstString(stringValue(source.refresh_token), stringValue(source.refreshToken));
  const idToken = firstString(stringValue(source.id_token), stringValue(source.idToken));
  const claims = decodeJwt(idToken ?? accessToken);
  const email = firstString(stringValue(source.email), stringValue(claims.email));
  const userId = firstString(stringValue(source.user_id), stringValue(claims.sub));
  const exp = typeof claims.exp === "number" ? claims.exp : undefined;
  const expiresAt = firstString(
    stringValue(source.expires_at),
    stringValue(source.expiresAt),
    exp ? new Date(exp * 1_000).toISOString() : undefined,
  );
  const credentials: GrokCredentials = {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    ...(email ? { email } : {}),
    ...(userId ? { userId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
  return {
    credentials,
    displayLabel: email ?? userId ?? `Grok …${accessToken.slice(-6)}`,
  };
}

export async function startDeviceOAuth(): Promise<OAuthStartResult> {
  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: oauthHeaders(),
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES, referrer: "grok-build" }),
  });
  const data = await responseRecord(response, "Grok device authorization failed");
  const deviceCode = stringValue(data.device_code);
  const userCode = stringValue(data.user_code);
  const verificationUrl = firstString(
    stringValue(data.verification_uri_complete),
    stringValue(data.verification_uri),
  );
  if (!deviceCode || !userCode || !verificationUrl) {
    throw new Error("Grok device authorization response is incomplete");
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 1_800;
  const interval = typeof data.interval === "number" && data.interval > 0 ? data.interval : 5;
  return {
    type: "device_code",
    userCode,
    verificationUrl,
    expiresInMs: expiresIn * 1_000,
    intervalMs: interval * 1_000,
    session: { deviceCode } satisfies DeviceSession,
  };
}

export async function pollDeviceOAuth(input: { session?: unknown }): Promise<OAuthPollResult> {
  const session = recordValue(input.session);
  const deviceCode = stringValue(session?.deviceCode);
  if (!deviceCode) {
    return { type: "failed", error: "Grok device session is missing" };
  }
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: oauthHeaders(),
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const data = recordValue(await response.json().catch(() => null)) ?? {};
  if (!response.ok) {
    const code = stringValue(data.error);
    if (code === "authorization_pending" || code === "slow_down") {
      return { type: "pending" };
    }
    return {
      type: "failed",
      error: firstString(stringValue(data.error_description), code) ?? `Grok OAuth failed (${response.status})`,
    };
  }
  const normalized = normalizeCredentials(data);
  return { type: "complete", ...normalized };
}

export async function keepalive(input: KeepaliveInput): Promise<KeepaliveResult> {
  const credentials = readCredentials(input.credentials);
  const dueMs = millisecondsUntilRefresh(credentials.expiresAt);
  if (dueMs > 0) {
    return { status: "ok", nextDueMs: dueMs };
  }
  if (!credentials.refreshToken) {
    const error = "Grok access token expired";
    input.log.warn({ status: "needs_reauth", error }, "token refresh failed");
    return { status: "needs_reauth", error };
  }
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: oauthHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: credentials.refreshToken,
    }),
    signal: input.signal,
  });
  const tokenData = recordValue(await response.json().catch(() => null)) ?? {};
  if (!response.ok) {
    const detail = firstString(stringValue(tokenData.error_description), stringValue(tokenData.error));
    const status = response.status === 400 || response.status === 401 ? "needs_reauth" : "failed";
    const error = `Grok token refresh failed (${response.status})${detail ? `: ${detail}` : ""}`;
    input.log.warn({ status, error, httpStatus: response.status }, "token refresh failed");
    return { status, error };
  }
  const normalized = normalizeCredentials({
    ...credentials,
    ...tokenData,
    refresh_token: stringValue(tokenData.refresh_token) ?? credentials.refreshToken,
  });
  const refreshed = normalized.credentials as GrokCredentials;
  return {
    status: "ok",
    ...normalized,
    nextDueMs: millisecondsUntilRefresh(refreshed.expiresAt),
  };
}

export async function chatCompletions(
  request: JsonPostRequest,
  connection: ProviderConnection,
): Promise<HttpExchange> {
  const credentials = readCredentials(connection.credentials);
  const chat = recordValue(request.body) ?? {};
  const streaming = chat.stream === true;
  const response = await fetch(`${PROXY_BASE_URL}/responses`, {
    method: "POST",
    headers: grokHeaders(credentials, streaming, stringValue(chat.model)),
    body: JSON.stringify(toResponsesRequest(chat)),
    signal: request.signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.body || !contentType.includes("text/event-stream")) {
    return {
      status: response.status,
      headers: pickResponseHeaders(response.headers),
      body: response.ok && response.body
        ? new Response(JSON.stringify(toChatResponse(await response.json() as unknown))).body
        : response.body,
      parseUsage: parseOpenAIChatUsage,
    };
  }
  if (streaming) {
    return {
      status: response.status,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: translateResponsesStream(response.body, stringValue(chat.model) ?? "grok"),
      parseUsage: parseOpenAIChatUsage,
    };
  }
  const body = await collectResponsesChat(response.body, stringValue(chat.model) ?? "grok");
  return {
    status: response.status,
    headers: { "content-type": "application/json" },
    body: new Response(JSON.stringify(body)).body,
    parseUsage: parseOpenAIChatUsage,
  };
}

export async function listModels(
  request: JsonGetRequest,
  connection: ProviderConnection,
): Promise<ModelList> {
  const response = await fetch(`${PROXY_BASE_URL}/models`, {
    headers: grokHeaders(readCredentials(connection.credentials), false),
    signal: request.signal,
  });
  const payload = await responseRecord(response, "Grok models request failed");
  return toModelList(payload as unknown);
}

export async function responses(
  request: JsonPostRequest,
  connection: ProviderConnection,
): Promise<HttpExchange> {
  const credentials = readCredentials(connection.credentials);
  const body = recordValue(request.body) ?? {};
  const streaming = body.stream === true;
  const response = await fetch(`${PROXY_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      ...request.headers,
      ...grokHeaders(credentials, streaming, stringValue(body.model)),
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });
  return {
    status: response.status,
    headers: pickResponseHeaders(response.headers),
    body: response.body,
    parseUsage: parseOpenAIResponsesUsage,
  };
}

function toResponsesRequest(chat: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const input = messages.flatMap((raw) => responsesInputItems(recordValue(raw) ?? {}));
  const tools = Array.isArray(chat.tools)
    ? chat.tools.slice(0, 200).map((raw) => {
        const tool = recordValue(raw) ?? {};
        const fn = recordValue(tool.function);
        return fn ? { type: "function", ...fn } : tool;
      })
    : undefined;
  return {
    model: stringValue(chat.model) ?? "grok-composer-2.5-fast",
    input,
    stream: chat.stream === true,
    store: false,
    include: ["reasoning.encrypted_content"],
    ...(tools ? { tools } : {}),
    ...(chat.tool_choice === undefined ? {} : { tool_choice: chat.tool_choice }),
  };
}

function responsesInputItems(message: Record<string, unknown>): unknown[] {
  if (message.role === "tool") {
    const callId = stringValue(message.tool_call_id);
    if (!callId) return [];
    return [{ type: "function_call_output", call_id: callId, output: toolOutput(message.content) }];
  }
  const role = message.role === "system" ? "developer" : stringValue(message.role) ?? "user";
  const content = responsesContent(role, message.content);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const items: unknown[] = [];
  if (calls.length === 0 || contentHasText(content)) {
    items.push({ type: "message", role, content });
  }
  for (const raw of calls) {
    const call = recordValue(raw);
    const fn = recordValue(call?.function);
    const callId = stringValue(call?.id);
    const name = stringValue(fn?.name);
    if (!callId || !name) continue;
    items.push({
      type: "function_call",
      call_id: callId,
      name,
      arguments: typeof fn?.arguments === "string" ? fn.arguments : "{}",
    });
  }
  return items;
}

function responsesContent(role: string, content: unknown): unknown {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") return [{ type: textType, text: content }];
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    const record = recordValue(part);
    if (record?.type !== "text") return part;
    return { type: textType, text: record.text };
  });
}

function contentHasText(content: unknown): boolean {
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (typeof part === "string") return part.length > 0;
    const record = recordValue(part);
    return typeof record?.text === "string" && record.text.length > 0;
  });
}

function toolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      const record = recordValue(part);
      return typeof record?.text === "string" ? record.text : "";
    }).join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function toChatResponse(input: unknown): unknown {
  const response = recordValue(input);
  if (!response || !Array.isArray(response.output)) return input;
  const translator = new ResponsesChatTranslator(stringValue(response.model) ?? "grok");
  translator.absorbResponse(response);
  return translator.completion();
}

function translateResponsesStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const translator = new ResponsesChatTranslator(model);
  let buffer = "";
  const emit = (
    controller: TransformStreamDefaultController<Uint8Array>,
    result: { chunks: unknown[]; done: boolean },
  ) => {
    for (const chunk of result.chunks) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    }
    if (result.done) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const parsed = parseSseEvent(event);
        if (!parsed) continue;
        emit(controller, translator.push(parsed));
      }
    },
    flush(controller) {
      if (buffer.trim()) {
        const parsed = parseSseEvent(buffer);
        if (parsed) emit(controller, translator.push(parsed));
      }
      buffer = "";
      if (!translator.done) emit(controller, translator.finish());
    },
  }));
}

async function collectResponsesChat(body: ReadableStream<Uint8Array>, model: string): Promise<unknown> {
  const translator = new ResponsesChatTranslator(model);
  const raw = await new Response(body).text();
  for (const event of raw.split("\n\n")) {
    const parsed = parseSseEvent(event);
    if (parsed) translator.push(parsed);
  }
  return translator.completion();
}

function parseSseEvent(event: string): Record<string, unknown> | undefined {
  const data = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return undefined;
  try {
    return recordValue(JSON.parse(data));
  } catch {
    return undefined;
  }
}

type FinishReason = "stop" | "tool_calls" | "length";

type FunctionCallState = {
  index: number;
  id: string;
  name: string;
  arguments: string;
  pending: string;
  sentId: boolean;
  sentName: boolean;
};

class ResponsesChatTranslator {
  id = `chatcmpl-${crypto.randomUUID()}`;
  model: string;
  created = Math.floor(Date.now() / 1_000);
  done = false;
  private text = "";
  private pendingText = "";
  private sentRole = false;
  private idLocked = false;
  private calls: FunctionCallState[] = [];
  private callsByKey = new Map<string, FunctionCallState>();
  private usage: Record<string, unknown> | null = null;
  private finishReason: FinishReason = "stop";

  constructor(model: string) {
    this.model = model;
  }

  push(event: Record<string, unknown>): { chunks: unknown[]; done: boolean } {
    if (this.done) return { chunks: [], done: true };
    const type = event.type;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      this.observeText(event.delta);
      return { chunks: this.pendingChunks(false), done: false };
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = recordValue(event.item);
      if (item?.type === "function_call") {
        const call = this.ensureCall(item);
        this.observeFinalArguments(call, typeof item.arguments === "string" ? item.arguments : "");
        return { chunks: this.pendingChunks(false), done: false };
      }
      if (item?.type === "message" && type === "response.output_item.done") {
        this.observeText(messageText(item));
        return { chunks: this.pendingChunks(false), done: false };
      }
    }
    if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      this.appendArguments(this.ensureCall(event), event.delta);
      return { chunks: this.pendingChunks(false), done: false };
    }
    if (type === "response.function_call_arguments.done") {
      const call = this.ensureCall(event);
      const name = stringValue(event.name);
      if (name && !call.name) call.name = name;
      this.observeFinalArguments(call, typeof event.arguments === "string" ? event.arguments : "");
      return { chunks: this.pendingChunks(false), done: false };
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      const response = recordValue(event.response);
      if (response) this.absorbResponse(response);
      return this.finish();
    }
    const response = recordValue(event.response);
    if (response && (type === "response.created" || type === "response.in_progress")) {
      this.noteIdentity(response);
    }
    return { chunks: [], done: false };
  }

  finish(): { chunks: unknown[]; done: boolean } {
    if (this.done) return { chunks: [], done: true };
    const chunks = this.pendingChunks(true);
    chunks.push(this.chunk({}, this.calls.length > 0 && this.finishReason === "stop" ? "tool_calls" : this.finishReason, true));
    this.done = true;
    return { chunks, done: true };
  }

  absorbResponse(response: Record<string, unknown>): void {
    this.noteIdentity(response);
    this.usage = chatUsage(response.usage) ?? this.usage;
    if (Array.isArray(response.output)) {
      for (const raw of response.output) {
        const item = recordValue(raw);
        if (!item) continue;
        if (item.type === "message") this.observeText(messageText(item));
        if (item.type === "function_call") {
          const call = this.ensureCall(item);
          this.observeFinalArguments(call, typeof item.arguments === "string" ? item.arguments : "");
        }
      }
    }
    this.finishReason = finishReasonFor(response, this.calls.length > 0);
  }

  completion(): Record<string, unknown> {
    const toolCalls = this.calls.map((call) => ({
      id: call.id || `call_${call.index}`,
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments },
    }));
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: this.text.length > 0 ? this.text : toolCalls.length > 0 ? null : "",
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: this.calls.length > 0 && this.finishReason === "stop" ? "tool_calls" : this.finishReason,
      }],
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }

  private pendingChunks(force: boolean): unknown[] {
    const chunks: unknown[] = [];
    const text = this.pendingText;
    this.pendingText = "";
    if (text) chunks.push(this.chunk({ content: text }));
    const tools = this.takeToolDeltas(force);
    if (tools.length > 0) chunks.push(this.chunk({ tool_calls: tools }));
    return chunks;
  }

  private chunk(delta: Record<string, unknown>, finish: FinishReason | null = null, withUsage = false): unknown {
    this.idLocked = true;
    const body = !this.sentRole && finish === null ? { role: "assistant", ...delta } : delta;
    if (finish === null) this.sentRole = true;
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: body, finish_reason: finish }],
      ...(withUsage && this.usage ? { usage: this.usage } : {}),
    };
  }

  private noteIdentity(response: Record<string, unknown>): void {
    if (this.idLocked) return;
    const id = stringValue(response.id);
    if (id) this.id = id.startsWith("chatcmpl-") ? id : `chatcmpl-${id}`;
    const model = stringValue(response.model);
    if (model) this.model = model;
    if (typeof response.created_at === "number") this.created = response.created_at;
  }

  private observeText(next: string): void {
    if (!next) return;
    if (next.startsWith(this.text)) {
      const rest = next.slice(this.text.length);
      this.text = next;
      if (rest) this.pendingText += rest;
      return;
    }
    this.text += next;
    this.pendingText += next;
  }

  private ensureCall(source: Record<string, unknown>): FunctionCallState {
    const item = recordValue(source.item);
    const key = stringValue(source.item_id)
      ?? stringValue(item?.id)
      ?? stringValue(source.id)
      ?? stringValue(source.call_id)
      ?? stringValue(item?.call_id)
      ?? `output-${String(source.output_index ?? this.calls.length)}`;
    let call = this.callsByKey.get(key);
    if (!call) {
      call = {
        index: this.calls.length,
        id: "",
        name: "",
        arguments: "",
        pending: "",
        sentId: false,
        sentName: false,
      };
      this.calls.push(call);
      this.callsByKey.set(key, call);
    }
    const seed = item ?? source;
    const id = stringValue(seed.call_id) ?? (seed === source ? undefined : stringValue(seed.id));
    const name = stringValue(seed.name);
    if (id && !call.id) call.id = id;
    if (name && !call.name) call.name = name;
    this.callsByKey.set(key, call);
    if (call.id) this.callsByKey.set(call.id, call);
    const itemId = stringValue(item?.id) ?? (item ? undefined : stringValue(source.id));
    if (itemId) this.callsByKey.set(itemId, call);
    return call;
  }

  private appendArguments(call: FunctionCallState, delta: string): void {
    if (!delta) return;
    call.arguments += delta;
    call.pending += delta;
  }

  private observeFinalArguments(call: FunctionCallState, finalArguments: string): void {
    if (!finalArguments || finalArguments === call.arguments) return;
    if (finalArguments.startsWith(call.arguments)) {
      call.pending += finalArguments.slice(call.arguments.length);
      call.arguments = finalArguments;
      return;
    }
    if (!call.arguments) {
      call.arguments = finalArguments;
      call.pending += finalArguments;
    }
  }

  private takeToolDeltas(force: boolean): unknown[] {
    const deltas: unknown[] = [];
    for (const call of this.calls) {
      const fn: Record<string, string> = {};
      const canSendName = call.name.length > 0 && !call.sentName;
      if (!force && !canSendName && !call.sentName) continue;
      if (canSendName) {
        fn.name = call.name;
        call.sentName = true;
        if (!call.pending) fn.arguments = "";
      }
      if (call.pending && (call.sentName || force)) {
        fn.arguments = call.pending;
        call.pending = "";
      }
      if (Object.keys(fn).length === 0) continue;
      const tool: Record<string, unknown> = { index: call.index, function: fn };
      if (!call.sentId && call.id) {
        tool.id = call.id;
        tool.type = "function";
        call.sentId = true;
      }
      deltas.push(tool);
    }
    return deltas;
  }
}

function messageText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) return "";
  return item.content.flatMap((part) => {
    const content = recordValue(part);
    return typeof content?.text === "string" ? [content.text] : [];
  }).join("");
}

function finishReasonFor(response: Record<string, unknown>, hasTools: boolean): FinishReason {
  const incomplete = recordValue(response.incomplete_details);
  if (stringValue(incomplete?.reason) === "max_output_tokens" || response.status === "incomplete") {
    return "length";
  }
  return hasTools ? "tool_calls" : "stop";
}

function chatUsage(usage: unknown): Record<string, unknown> | null {
  const record = recordValue(usage);
  if (!record) return null;
  if ("prompt_tokens" in record || "completion_tokens" in record) return record;
  if (!("input_tokens" in record || "output_tokens" in record)) return null;
  const input = tokenCount(record.input_tokens);
  const output = tokenCount(record.output_tokens);
  const details = recordValue(record.input_tokens_details) ?? {};
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: tokenCount(record.total_tokens) || input + output,
    prompt_tokens_details: { cached_tokens: tokenCount(details.cached_tokens) },
  };
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function grokHeaders(
  credentials: GrokCredentials,
  stream: boolean,
  model?: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${credentials.accessToken}`,
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    "x-xai-token-auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-mode": "headless",
    "x-grok-client-version": GROK_CLIENT_VERSION,
    "user-agent": `grok-shell/${GROK_CLIENT_VERSION}`,
    ...(model ? { "x-grok-model-override": model } : {}),
    ...(credentials.userId ? { "x-userid": credentials.userId, "x-grok-user-id": credentials.userId } : {}),
    ...(credentials.email ? { "x-email": credentials.email } : {}),
  };
}

function oauthHeaders(): Record<string, string> {
  return {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-mode": "headless",
    "x-grok-client-version": GROK_CLIENT_VERSION,
  };
}

function pickResponseHeaders(headers: Headers): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of ["content-type", "cache-control"]) {
    const value = headers.get(name);
    if (value) picked[name] = value;
  }
  return picked;
}

function readCredentials(input: unknown): GrokCredentials {
  return normalizeCredentials(input).credentials as GrokCredentials;
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find(Boolean);
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return {};
    return recordValue(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))) ?? {};
  } catch {
    return {};
  }
}

function millisecondsUntilRefresh(expiresAt: string | undefined): number {
  if (!expiresAt) return 60 * 60 * 1_000;
  return Math.max(0, Date.parse(expiresAt) - Date.now() - 5 * 60 * 1_000);
}

async function responseRecord(response: Response, prefix: string): Promise<Record<string, unknown>> {
  const data = recordValue(await response.json().catch(() => null)) ?? {};
  if (!response.ok) {
    const detail = firstString(stringValue(data.error_description), stringValue(data.error));
    throw new Error(`${prefix} (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return data;
}
