import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Api } from "./projects.ts";
import { record, State, textField } from "./state.ts";

export interface ContactScope { userId: string; organizationId: string; conversationId?: string }
export interface ContactConfig {
  apiUrl: string;
  apiKey?: string;
  coworkerId?: string;
  contactAccountsFile?: string;
}
export interface Contact { id: string; name: string; email: string }
export interface DirectSend extends ContactScope {
  id: string;
  key: string;
  request: { query?: string; recipientId?: string; roomId?: string; content: string; coordination?: string };
  recipient?: Contact;
  roomId?: string;
  messageId?: string;
  coworkerId: string;
  status: "queued" | "sending" | "accepted" | "uncertain" | "failed";
  stage: "directory" | "room" | "message";
  retrySafe: boolean;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
export class ContactHttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`Sokosumi contact request returned HTTP ${status}`);
    this.status = status;
  }
}

// Fixed-operation callers only. No upstream errors/credentials are echoed, no
// redirects forward bearer credentials, and POSTs are never retried here.
export function contactApi(apiUrl: string, token: string): Api {
  const base = new URL(apiUrl);
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== "https:" && !(base.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))))
    throw new Error("Contact API requires HTTPS (loopback HTTP is allowed for tests)");
  return async (path, method = "GET", body, headers = {}) => {
    const response = await fetch(base.href.replace(/\/$/, "") + path, {
      method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new ContactHttpError(response.status);
    try { return record(await response.json()); }
    catch { throw new Error("Invalid Sokosumi contact response"); }
  };
}

function privateJson(path: string): unknown {
  if (!isAbsolute(path)) throw new Error("Contact account paths must be absolute");
  let info;
  try { info = statSync(path); }
  catch { throw new Error("Contact account file is unavailable; check the configured private path"); }
  if (!info.isFile() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid()))
    throw new Error("Contact account files must be owned by the service user and mode 600");
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Cannot read contact account JSON; inspect the private file locally"); }
}

// Configuration is selected by stored request identity, never by model-supplied
// paths, headers or identity claims. Reuse the private owner-config format.
function contactAccountEntry(config: ContactConfig, scope: ContactScope): Record<string, unknown> {
  if (!config.contactAccountsFile) throw new Error("Directory access is not configured for this user/organization");
  const entries = privateJson(config.contactAccountsFile);
  if (!Array.isArray(entries)) throw new Error("Invalid contact account registry");
  const matches = entries.map(record).filter(entry =>
    entry.userId === scope.userId && entry.organizationId === scope.organizationId);
  if (matches.length !== 1) throw new Error("Exactly one directory account is required for this user/organization");
  return matches[0];
}
export function contactOwnerApi(config: ContactConfig, scope: ContactScope): Api {
  const entry = contactAccountEntry(config, scope);
  const account = record(privateJson(textField(entry, "configPath")));
  if (account.userId !== scope.userId || account.organizationId !== scope.organizationId)
    throw new Error("Directory account identity does not match the requesting user/organization");
  const apiUrl = typeof account.apiUrl === "string" ? account.apiUrl : "https://api.sokosumi.com/v1";
  if (apiUrl.replace(/\/$/, "") !== config.apiUrl.replace(/\/$/, ""))
    throw new Error("Directory and coworker API origins must match");
  const token = textField(account, "token");
  if (/^(coworker_|sokoBot_)/.test(token)) throw new Error("Directory access requires the requesting user's credential, not an agent key");
  return contactApi(apiUrl, token);
}

function normalized(value: string): string { return value.trim().toLowerCase(); }
function bounded(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${name} must be a nonempty string of at most ${max} characters`);
  return value;
}
function uuid(value: unknown): string {
  const id = bounded(value, "Room ID", 36);
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid room UUID");
  return id;
}

export class Contacts {
  state: State;
  config: ContactConfig;
  // These two adapters are replaceable for deterministic tests, not control inputs.
  ownerApi: (scope: ContactScope) => Api;
  senderApi: () => Api;
  constructor(state: State, config: ContactConfig) {
    this.state = state;
    this.config = config;
    this.ownerApi = scope => contactOwnerApi(this.config, scope);
    this.senderApi = () => contactApi(this.config.apiUrl, this.config.apiKey!);
    // A persisted message intent may already have committed. The room endpoint
    // is create-or-get for the same pair, so pre-message recovery is safe.
    for (const item of state.all<DirectSend>("directSends")) {
      if (item.status !== "sending") continue;
      item.status = item.stage === "message" ? "uncertain" : "queued";
      item.retrySafe = item.stage !== "message";
      item.error = item.stage === "message" ? "Interrupted message POST; inspect the destination before any further send" : undefined;
      this.save(item);
    }
  }
  private save(item: DirectSend) {
    item.updatedAt = Date.now();
    this.state.put("directSends", item.id, item);
  }
  private key(scope: ContactScope, key: string) {
    bounded(key, "Send key", 128);
    return createHash("sha256").update(JSON.stringify([scope.userId, scope.organizationId, key])).digest("hex");
  }
  private ready() {
    if (!this.config.coworkerId || !this.config.apiKey?.startsWith("coworker_"))
      throw new Error("Native messaging requires the configured dedicated coworker ID and coworker API key");
  }
  get(scope: ContactScope, key: string): DirectSend {
    const id = this.state.get<string>("directSendKeys", this.key(scope, key));
    const item = id ? this.state.get<DirectSend>("directSends", id) : undefined;
    if (!item || item.userId !== scope.userId || item.organizationId !== scope.organizationId)
      throw new Error("No send with this key for the requesting user/organization");
    return item;
  }
  recent(scope: ContactScope) {
    return this.state.all<DirectSend>("directSends")
      .filter(item => item.userId === scope.userId && item.organizationId === scope.organizationId)
      .slice(-20).reverse().map(item => ({
        id: item.id, key: item.key, status: item.status, retrySafe: item.retrySafe,
        recipient: item.recipient, roomId: item.roomId, messageId: item.messageId, error: item.error,
      }));
  }
  async directory(scope: ContactScope): Promise<Contact[]> {
    const api = this.ownerApi(scope);
    const me = record((await api("/users/me")).data);
    if (me.id !== scope.userId) throw new Error("Authenticated directory user does not match the requester");
    const users = new Map<string, Contact>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      // The current endpoint returns an unpaginated array. Also support explicit
      // cursor metadata if the upstream adds pagination; never truncate it.
      const path = `/organizations/${encodeURIComponent(scope.organizationId)}/members` +
        (cursor ? `?${new URLSearchParams({ cursor, limit: "100" })}` : "");
      const response = await api(path);
      if (!Array.isArray(response.data)) throw new Error("Invalid organization directory response");
      for (const raw of response.data) {
        const member = record(raw);
        if (member.organizationId !== scope.organizationId) throw new Error("Directory returned another organization");
        const user = record(member.user);
        const contact = { id: textField(user, "id"), name: textField(user, "name"), email: textField(user, "email") };
        const old = users.get(contact.id);
        if (old && JSON.stringify(old) !== JSON.stringify(contact)) throw new Error("Directory changed during pagination; retry lookup");
        users.set(contact.id, contact);
      }
      const pagination = record(response.meta ?? {}).pagination;
      if (pagination === undefined && cursor) throw new Error("Directory pagination disappeared; lookup incomplete");
      if (pagination === undefined || record(pagination).nextCursor === null) {
        if (!users.has(scope.userId)) throw new Error("Requester is not a member of the selected organization");
        return [...users.values()];
      }
      const next = record(pagination).nextCursor;
      if (typeof next !== "string" || !next || cursors.has(next)) throw new Error("Invalid or repeated directory cursor");
      cursors.add(next);
      cursor = next;
    }
    throw new Error("Directory pagination limit exceeded; lookup incomplete");
  }
  async lookup(scope: ContactScope, query: string): Promise<Contact[]> {
    bounded(query, "Contact query", 200);
    const target = normalized(query);
    return (await this.directory(scope)).filter(user => target.includes("@")
      ? normalized(user.email) === target : normalized(user.name).includes(target));
  }
  coordinationAllowed(scope: ContactScope): boolean {
    try { return contactAccountEntry(this.config, scope).taskCoordination === true; }
    catch { return false; }
  }
  private checkCoordination(scope: ContactScope, rationale?: string): void {
    if (rationale !== undefined && !this.coordinationAllowed(scope))
      throw new Error("Routine task coordination is not enabled for this requester/organization; an existing standing preference must be configured before proactive contact");
  }
  queue(scope: ContactScope, key: string, body: Record<string, unknown>): DirectSend {
    const query = body.query === undefined ? undefined : bounded(body.query, "Contact query", 200).trim();
    const recipientId = body.recipientId === undefined ? undefined : bounded(body.recipientId, "Recipient ID", 200);
    if (Boolean(query) === Boolean(recipientId)) throw new Error("Select exactly one contact query or verified recipient ID");
    const coordination = body.coordination === undefined ? undefined : bounded(body.coordination, "Authorized task coordination purpose", 1000).trim();
    const request = { ...(coordination === undefined ? {} : { coordination }), query, recipientId, roomId: body.roomId === undefined ? undefined : uuid(body.roomId), content: bounded(body.text, "Message", 10000) };
    const lookup = this.key(scope, key);
    return this.state.transaction(() => {
      if (this.state.get("directSendKeys", lookup)) {
        const old = this.get(scope, key);
        // JSON persistence omits undefined fields, as does stringify here.
        if (JSON.stringify(old.request) !== JSON.stringify(request)) throw new Error("Send key already belongs to a different message/destination");
        return old;
      }
      this.checkCoordination(scope, coordination);
      this.ready();
      const item: DirectSend = { ...scope, id: randomUUID(), key, request, coworkerId: this.config.coworkerId!, status: "queued", stage: "directory", retrySafe: true, createdAt: Date.now(), updatedAt: Date.now() };
      this.save(item);
      this.state.put("directSendKeys", lookup, item.id);
      return item;
    });
  }
  retry(scope: ContactScope, key: string): DirectSend {
    return this.state.transaction(() => {
      const item = this.get(scope, key);
      if (item.status !== "failed" || !item.retrySafe) throw new Error("Only a safely failed send can be retried; uncertain/accepted sends must not be replayed");
      this.ready();
      item.status = "queued";
      item.error = undefined;
      this.save(item);
      return item;
    });
  }
  private verifyRoom(raw: unknown, item: DirectSend): string {
    const room = record(raw);
    const humans = Array.isArray(room.userMembers) ? room.userMembers.map(record) : [];
    const coworkers = Array.isArray(room.coworkerMembers) ? room.coworkerMembers.map(record) : [];
    if (room.kind !== "direct" || room.organizationId !== item.organizationId ||
        humans.length !== 1 || humans[0].id !== item.recipient?.id ||
        coworkers.length !== 1 || coworkers[0].id !== item.coworkerId ||
        !Array.isArray(room.sokoBotMembers) || room.sokoBotMembers.length !== 0 ||
        (item.request.roomId && room.id !== item.request.roomId))
      throw new Error("Room roster does not match the verified recipient, coworker and organization");
    return uuid(room.id);
  }
  async deliver(): Promise<void> {
    const pending = this.state.all<DirectSend>("directSends").filter(item => item.status === "queued").slice(0, 4);
    await Promise.all(pending.map(item => this.deliverQueued(item.id)));
  }
  async deliverQueued(id: string): Promise<void> {
    const item = this.state.transaction(() => {
      const current = this.state.get<DirectSend>("directSends", id);
      if (!current || current.status !== "queued") return undefined;
      current.status = "sending";
      current.stage = "directory";
      this.save(current);
      return current;
    });
    if (!item) return;
    try {
      this.checkCoordination(item, item.request.coordination);
      this.ready();
      if (item.coworkerId !== this.config.coworkerId) throw new Error("Configured coworker changed; retained send cannot switch sender identity");
      const users = await this.directory(item);
      const pinnedId = item.recipient?.id ?? item.request.recipientId;
      const matches = pinnedId ? users.filter(user => user.id === pinnedId) : users.filter(user => {
        const query = normalized(item.request.query!);
        return query.includes("@") ? normalized(user.email) === query : normalized(user.name).includes(query);
      });
      if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous recipient; use contacts and select an exact ID" : "Recipient not found in the authorized organization");
      item.recipient = matches[0];
      item.stage = "room";
      this.save(item);
      const headers = { "X-Context-User-Id": item.userId, "X-Context-Organization-Id": item.organizationId };
      const sender = this.senderApi();
      const room = item.request.roomId
        ? await this.ownerApi(item)(`/chats/rooms/${encodeURIComponent(item.request.roomId)}`)
        : await sender("/chats/rooms", "POST", { kind: "direct", memberUserIds: [item.recipient.id] }, headers);
      item.roomId = this.verifyRoom(room.data, item);
      item.stage = "message";
      item.retrySafe = false;
      this.save(item); // Durable intent precedes the only message POST.
      const message = record((await sender(`/chats/rooms/${encodeURIComponent(item.roomId)}/messages`, "POST", {
        content: item.request.content, clientMessageId: item.id,
      }, headers)).data);
      const author = record(message.sender);
      if (message.roomId !== item.roomId || message.content !== item.request.content ||
          author.type !== "coworker" || record(author.coworker).id !== item.coworkerId)
        throw new Error("Message response did not confirm the requested destination/content");
      item.messageId = textField(message, "id");
      item.status = "accepted";
      item.error = undefined;
    } catch (error) {
      const rejected = error instanceof ContactHttpError && [400, 401, 403, 404, 422, 429].includes(error.status);
      item.retrySafe = item.stage !== "message" || rejected;
      item.status = item.retrySafe ? "failed" : "uncertain";
      // Never save upstream bodies, credentials or user API URLs in errors.
      item.error = error instanceof ContactHttpError ? error.message
        : item.stage === "message" ? "Message outcome uncertain; do not replay without authorized reconciliation"
        : error instanceof Error && !["TypeError", "SyntaxError"].includes(error.name) ? error.message
        : "Contact request failed before message submission; inspect access and retry explicitly";
    }
    this.save(item);
  }
}
