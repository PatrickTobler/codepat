import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { join } from "node:path";
import {
  AttachmentError,
  attachmentText,
  MAX_RESPONSE_BODY_BYTES,
} from "./attachments.ts";

export interface ChatResponse {
  id: string;
  conversationId: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  text: string;
  error?: string;
}

export interface ChatService {
  createConversation(
    owner: string,
    metadata: Record<string, string>,
  ): { id: string };
  conversationOwner(id: string): string | undefined;
  createResponse(
    owner: string,
    conversationId: string,
    input: string,
    idempotencyKey?: string,
  ): { id: string };
  getResponse(id: string): ChatResponse | undefined;
  waitResponse(id: string, signal: AbortSignal): Promise<void>;
}

export interface CodePatServerOptions {
  organizationId: string;
  attachmentDirectory?: string;
  ownerId?: string;
  service: ChatService;
  controlToken: string;
  authorizeControl?: (
    token: string,
    action: string,
    body: Record<string, unknown>,
  ) => boolean;
  control: (action: string, body: Record<string, unknown>) => Promise<unknown>;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

async function readBody(
  req: IncomingMessage,
  limit = 1024 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Do not destroy the request on overflow: send the 413 before closing it.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit)
      throw new HttpError(
        413,
        `Request body exceeds ${limit / (1024 * 1024)} MiB`,
      );
    chunks.push(chunk);
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON");
  }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const actual = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

async function inputText(
  input: unknown,
  directory: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (typeof input === "string" && input.trim()) return input;
  if (!Array.isArray(input) || input.length === 0)
    throw new HttpError(400, "Nonempty input required");
  const messages: string[] = [];
  let attachments = 0;
  for (const value of input) {
    const message = object(value);
    if (
      (message.type !== undefined && message.type !== "message") ||
      !["user", "assistant", "system", "developer"].includes(
        String(message.role),
      )
    )
      throw new HttpError(400, "Only message input is supported");
    let text: string;
    if (typeof message.content === "string") text = message.content;
    else if (Array.isArray(message.content) && message.content.length > 0) {
      const parts: string[] = [];
      for (const value of message.content) {
        const part = object(value);
        if (
          ["input_text", "output_text"].includes(String(part.type)) &&
          typeof part.text === "string"
        ) {
          parts.push(part.text);
        } else if (["input_image", "input_file"].includes(String(part.type))) {
          if (++attachments > 8)
            throw new HttpError(
              400,
              "At most 8 attachments per request are supported",
            );
          parts.push(await attachmentText(part, directory, signal));
        } else
          throw new HttpError(
            400,
            "Supported content types: input_text, output_text, input_image, input_file",
          );
      }
      text = parts.join("\n");
    } else throw new HttpError(400, "Message content required");
    messages.push(`${message.role}: ${text}`);
  }
  if (
    !messages.some((message) => message.slice(message.indexOf(":") + 1).trim())
  )
    throw new HttpError(400, "Nonempty input required");
  return messages.join("\n\n");
}

function responseObject(response: ChatResponse) {
  return {
    id: response.id,
    object: "response",
    status: response.status,
    conversation: { id: response.conversationId },
    model: "codepat",
    output: response.text
      ? [
          {
            id: `msg_${response.id}`,
            type: "message",
            role: "assistant",
            status:
              response.status === "completed" ? "completed" : "in_progress",
            content: [
              { type: "output_text", text: response.text, annotations: [] },
            ],
          },
        ]
      : [],
    output_text: response.text,
    error: response.error
      ? { code: "server_error", message: response.error }
      : null,
  };
}

export function createCodePatServer(options: CodePatServerOptions) {
  if (!options.controlToken) throw new Error("Nonempty control token required");
  if (!options.organizationId.trim())
    throw new Error("Organization ID required");
  const { service } = options;
  function ownConversation(id: string, ownerId: string) {
    const owner = service.conversationOwner(id);
    if (!owner) throw new HttpError(404, "Conversation not found");
    if (owner !== ownerId) throw new HttpError(403, "Forbidden");
  }
  function getResponse(id: string, ownerId: string) {
    const response = service.getResponse(id);
    if (!response) throw new HttpError(404, "Response not found");
    ownConversation(response.conversationId, ownerId);
    return response;
  }
  return createServer(async (req, res) => {
    const abort = new AbortController();
    const disconnect = () => abort.abort();
    res.once("close", disconnect);
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let sequence = 0;
    const event = (type: string, value: Record<string, unknown>) => {
      if (!res.destroyed)
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`,
        );
    };
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/health") {
        json(res, 200, { status: "ok" });
        return;
      }
      const controlMatch = /^\/control\/([a-z][a-z0-9-]*)$/.exec(path);
      if (controlMatch) {
        const bearer = /^Bearer (\S+)$/.exec(
          req.headers.authorization ?? "",
        )?.[1];
        if (!bearer) throw new HttpError(401, "Unauthorized");
        const isMaster = authorized(req, options.controlToken);
        if (!isMaster && !options.authorizeControl)
          throw new HttpError(401, "Unauthorized");
        if (req.method !== "POST")
          throw new HttpError(405, "Method not allowed");
        const body = await readBody(req);
        if (
          !isMaster &&
          options.authorizeControl?.(bearer, controlMatch[1], body) !== true
        )
          throw new HttpError(401, "Unauthorized");
        json(res, 200, await options.control(controlMatch[1], body));
        return;
      }
      // Organisation filtering is not cryptographic caller authentication.
      if (req.headers["x-sokosumi-organization-id"] !== options.organizationId)
        throw new HttpError(403, "Organisation not allowed");
      const ownerId = req.headers["x-sokosumi-user-id"];
      if (
        typeof ownerId !== "string" ||
        !ownerId.trim() ||
        (options.ownerId && ownerId !== options.ownerId)
      )
        throw new HttpError(403, "Forbidden");
      if (req.method === "POST" && path === "/v1/conversations") {
        const body = await readBody(req);
        if (body.items !== undefined)
          throw new HttpError(
            400,
            "Initial items are unsupported; send them through responses",
          );
        const rawMetadata =
          body.metadata === undefined ? {} : object(body.metadata);
        const metadata: Record<string, string> = {};
        for (const [key, value] of Object.entries(rawMetadata)) {
          if (typeof value !== "string")
            throw new HttpError(400, "Metadata values must be strings");
          Object.defineProperty(metadata, key, { value, enumerable: true });
        }
        if (
          metadata.sokosumi_user_id !== undefined &&
          metadata.sokosumi_user_id !== ownerId
        )
          throw new HttpError(403, "Metadata owner mismatch");
        if (
          metadata.sokosumi_organization_id !== undefined &&
          metadata.sokosumi_organization_id !== options.organizationId
        )
          throw new HttpError(403, "Metadata organisation mismatch");
        const conversation = service.createConversation(ownerId, {
          ...metadata,
          sokosumi_organization_id: options.organizationId,
        });
        json(res, 200, {
          id: conversation.id,
          object: "conversation",
          created_at: Math.floor(Date.now() / 1000),
          metadata,
        });
        return;
      }
      const responseMatch = /^\/v1\/responses\/([^/]+)$/.exec(path);
      if (req.method === "GET" && responseMatch) {
        json(res, 200, responseObject(getResponse(responseMatch[1], ownerId)));
        return;
      }
      if (req.method !== "POST" || path !== "/v1/responses")
        throw new HttpError(404, "Not found");
      const body = await readBody(req, MAX_RESPONSE_BODY_BYTES);
      const conversationId =
        typeof body.conversation === "string"
          ? body.conversation
          : object(body.conversation).id;
      if (typeof conversationId !== "string" || !conversationId)
        throw new HttpError(400, "Conversation id required");
      if (body.stream !== undefined && typeof body.stream !== "boolean")
        throw new HttpError(400, "stream must be a boolean");
      if (body.previous_response_id !== undefined)
        throw new HttpError(
          400,
          "Use conversation instead of previous_response_id",
        );
      ownConversation(conversationId, ownerId);
      const key = req.headers["idempotency-key"];
      if (
        key !== undefined &&
        (typeof key !== "string" || !key.trim() || key.length > 256)
      )
        throw new HttpError(400, "Invalid idempotency key");
      const attachmentDirectory = options.attachmentDirectory
        ? join(
            options.attachmentDirectory,
            createHash("sha256").update(conversationId).digest("hex"),
          )
        : undefined;
      const input = await inputText(
        body.input,
        attachmentDirectory,
        abort.signal,
      );
      const { id } = service.createResponse(
        ownerId,
        conversationId,
        input,
        key,
      );
      // A client disconnect cancels only its waiter, never the persisted job.
      if (body.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        event("response.created", {
          response: responseObject(getResponse(id, ownerId)),
        });
        keepalive = setInterval(() => {
          if (!res.destroyed) res.write(": keepalive\n\n");
        }, 15_000);
        keepalive.unref();
      }
      await service.waitResponse(id, abort.signal);
      if (abort.signal.aborted) return;
      const response = getResponse(id, ownerId);
      if (body.stream) {
        if (response.text)
          event("response.output_text.delta", {
            item_id: `msg_${id}`,
            output_index: 0,
            content_index: 0,
            delta: response.text,
          });
        event(
          response.status === "failed"
            ? "response.failed"
            : "response.completed",
          { response: responseObject(response) },
        );
        res.end("data: [DONE]\n\n");
      } else json(res, 200, responseObject(response));
    } catch (error) {
      if (abort.signal.aborted || res.destroyed) return;
      const status =
        error instanceof HttpError || error instanceof AttachmentError
          ? error.status
          : 500;
      const message =
        error instanceof HttpError || error instanceof AttachmentError
          ? error.message
          : "Internal server error";
      if (res.headersSent) {
        event("error", { error: { code: "server_error", message } });
        res.end("data: [DONE]\n\n");
      } else {
        if (status === 413) res.setHeader("Connection", "close");
        json(res, status, { error: { message } });
      }
    } finally {
      if (keepalive) clearInterval(keepalive);
      res.off("close", disconnect);
    }
  });
}
