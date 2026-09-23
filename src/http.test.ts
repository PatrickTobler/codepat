import {ControlConflict} from "./control-error.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MAX_RESPONSE_BODY_BYTES } from "./attachments.ts";
import {
  type ChatResponse,
  type ChatService,
  type CodePatServerOptions,
  createCodePatServer,
} from "./http.ts";

async function fixture(
  t: TestContext,
  failed = false,
  authorizeControl?: CodePatServerOptions["authorizeControl"],
  control?: CodePatServerOptions["control"],
) {
  const attachmentDirectory = await mkdtemp(join(tmpdir(), "codepat-http-"));
  t.after(() => rm(attachmentDirectory, { recursive: true, force: true }));
  const owners = new Map<string, string>();
  const responses = new Map<string, ChatResponse>();
  const inputs: string[] = [];
  const service: ChatService = {
    createConversation(owner) {
      const id = `conv_${owners.size}`;
      owners.set(id, owner);
      return { id };
    },
    conversationOwner: (id) => owners.get(id),
    createResponse(_owner, conversationId, input) {
      const id = `resp_${responses.size}`;
      responses.set(id, { id, conversationId, status: "queued", text: "" });
      inputs.push(input);
      return { id };
    },
    getResponse: (id) => responses.get(id),
    async waitResponse(id) {
      const response = responses.get(id);
      assert.ok(response);
      response.status = failed ? "failed" : "completed";
      response.text = failed ? "" : "Worker started";
      if (failed) response.error = "Worker failed";
    },
  };
  const server = createCodePatServer({
    organizationId: "example-org-test-org",
    attachmentDirectory,
    controlToken: "private-secret",
    authorizeControl,
    service,
    control: control ?? (async (action) => ({ action })),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  function request(path: string, body?: unknown, owner = "alice", token = "") {
    return fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "x-sokosumi-user-id": owner,
        "x-sokosumi-organization-id": "example-org-test-org",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return { request, base, inputs, service };
}

test("chat accepts existing identity headers without bearer; controls require credentials", async (t) => {
  const { request, base } = await fixture(t);
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), {
    status: "ok",
  });
  assert.equal(
    (await fetch(`${base}/v1/conversations`, { method: "POST", body: "{}" }))
      .status,
    403,
  );
  assert.equal((await request("/v1/conversations", {}, "")).status, 403);
  assert.equal((await request("/control/spawn", {}, "alice")).status, 401);
  assert.equal(
    (await request("/control/spawn", {}, "", "private-secret")).status,
    200,
  );
  assert.equal((await request("/v1/conversations", {}, "alice")).status, 200);
});

test("two owners cannot access each other's conversations or responses", async (t) => {
  const { request } = await fixture(t);
  const conversation = await (await request("/v1/conversations", {})).json();
  assert.equal(
    (
      await request(
        "/v1/responses",
        { conversation: conversation.id, input: "hello" },
        "bob",
      )
    ).status,
    403,
  );
  const response = await (
    await request("/v1/responses", {
      conversation: conversation.id,
      input: "hello",
    })
  ).json();
  assert.equal(response.output_text, "Worker started");
  assert.equal(
    (await request(`/v1/responses/${response.id}`, undefined, "bob")).status,
    403,
  );
  assert.equal((await request(`/v1/responses/${response.id}`)).status, 200);
  assert.equal(
    (
      await request("/v1/conversations", {
        metadata: { sokosumi_user_id: "bob" },
      })
    ).status,
    403,
  );
  assert.equal((await request("/v1/conversations", {}, "bob")).status, 200);
});

test("SSE includes ordered created, delta, completed, and done", async (t) => {
  const { request, inputs } = await fixture(t);
  const { id } = await (await request("/v1/conversations", {})).json();
  const result = await request("/v1/responses", {
    conversation: id,
    stream: true,
    input: [
      { role: "user", content: [{ type: "input_text", text: "start worker" }] },
    ],
  });
  assert.match(result.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = await result.text();
  assert.match(
    events,
    /response.created[\s\S]*response.output_text.delta[\s\S]*response.completed[\s\S]*\[DONE\]/,
  );
  assert.deepEqual(inputs, ["user: start worker"]);
});

test("SSE failure is terminal and never marked completed", async (t) => {
  const { request } = await fixture(t, true);
  const { id } = await (await request("/v1/conversations", {})).json();
  const events = await (
    await request("/v1/responses", {
      conversation: id,
      stream: true,
      input: "hello",
    })
  ).text();
  assert.match(events, /response.failed[\s\S]*Worker failed[\s\S]*\[DONE\]/);
  assert.doesNotMatch(events, /response.completed/);
});

test("invalid JSON, oversized bodies and unsupported content are rejected", async (t) => {
  const { request, base, inputs } = await fixture(t);
  const { id } = await (await request("/v1/conversations", {})).json();
  const bad = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: {
      "x-sokosumi-user-id": "alice",
      "x-sokosumi-organization-id": "example-org-test-org",
    },
    body: "{",
  });
  assert.equal(bad.status, 400);
  for (const input of [
    "",
    [],
    [
      {
        role: "user",
        content: [
          { type: "input_text", text: "hello" },
          { type: "input_image", image_url: "https://example.com/a.png" },
        ],
      },
    ],
  ]) {
    assert.equal(
      (await request("/v1/responses", { conversation: id, input })).status,
      400,
    );
  }
  assert.equal(
    (await request("/v1/responses", { input: "hello" })).status,
    400,
  );
  assert.equal(
    (
      await request("/v1/responses", {
        conversation: id,
        input: "hello",
        stream: "true",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/v1/responses", {
        conversation: id,
        input: "x".repeat(MAX_RESPONSE_BODY_BYTES),
      })
    ).status,
    413,
  );
  assert.deepEqual(inputs, []);
});

test("disconnect cancels the waiter while retaining the response", async (t) => {
  const { request, base, service } = await fixture(t);
  let disconnected!: () => void;
  const waiterAborted = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  service.waitResponse = async (_id, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        disconnected();
        resolve();
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          disconnected();
          resolve();
        },
        { once: true },
      );
    });
  };
  const { id } = await (await request("/v1/conversations", {})).json();
  const abort = new AbortController();
  const response = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: {
      "x-sokosumi-user-id": "alice",
      "x-sokosumi-organization-id": "example-org-test-org",
    },
    body: JSON.stringify({ conversation: id, input: "work", stream: true }),
    signal: abort.signal,
  });
  const reader = response.body?.getReader();
  assert.ok(reader);
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /response.created/,
  );
  abort.abort();
  await waiterAborted;
  assert.equal(service.getResponse("resp_0")?.status, "queued");
  assert.equal((await request("/v1/responses/resp_0")).status, 200);
});

test("scoped control credentials authorize only the matching action and resource", async (t) => {
  const { request } = await fixture(
    t,
    false,
    (token, action, body) =>
      token === "worker-secret" &&
      action === "worker-result" &&
      body.jobId === "job-1" &&
      body.workerId === "worker-1",
  );
  const allowed = { jobId: "job-1", workerId: "worker-1", text: "done" };
  assert.equal(
    (await request("/control/worker-result", allowed, "", "worker-secret"))
      .status,
    200,
  );
  for (const [action, body, token] of [
    ["spawn", allowed, "worker-secret"],
    ["worker-result", { ...allowed, jobId: "job-2" }, "worker-secret"],
    ["worker-result", { ...allowed, workerId: "worker-2" }, "worker-secret"],
    ["worker-result", allowed, "unknown"],
    ["worker-result", allowed, ""],
  ] as const) {
    assert.equal(
      (await request(`/control/${action}`, body, "", token)).status,
      401,
    );
  }
  assert.equal(
    (await request("/v1/conversations", {}, "alice", "worker-secret")).status,
    200,
  );
  assert.equal(
    (await request("/control/spawn", {}, "", "private-secret")).status,
    200,
  );
});

test("missing credentials cannot authorize control even through a permissive callback", async (t) => {
  const { request } = await fixture(t, false, () => true);
  assert.equal((await request("/control/spawn", {})).status, 401);
  assert.equal((await request("/control/spawn", {}, "", "")).status, 401);
});

test("every chat route rejects missing or different organisation headers", async (t) => {
  const { base, request } = await fixture(t);
  for (const organization of [undefined, "other-org"]) {
    for (const path of [
      "/v1/conversations",
      "/v1/responses",
      "/v1/responses/example",
    ]) {
      const response = await fetch(`${base}${path}`, {
        method: path.endsWith("example") ? "GET" : "POST",
        headers: {
          "x-sokosumi-user-id": "alice",
          ...(organization
            ? { "x-sokosumi-organization-id": organization }
            : {}),
        },
      });
      assert.equal(response.status, 403);
    }
  }
  assert.equal(
    (
      await request("/v1/conversations", {
        metadata: { sokosumi_organization_id: "other-org" },
      })
    ).status,
    403,
  );
  assert.equal((await request("/v1/conversations", {})).status, 200);
});

test("Sokosumi image and file parts persist readable private files before queueing", async (t) => {
  const { request, inputs } = await fixture(t);
  const { id } = await (await request("/v1/conversations", {})).json();
  const input = [
    {
      role: "user",
      content: [
        { type: "input_text", text: "Use these attachments" },
        { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
        {
          type: "input_file",
          filename: "../notes.md",
          file_data: "data:text/markdown;base64,IyBOb3Rlcw==",
        },
      ],
    },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request("/v1/responses", {
      conversation: id,
      input,
    });
    assert.equal(response.status, 200);
  }
  assert.equal(inputs[0], inputs[1]);
  assert.match(inputs[0], /Use these attachments/);
  assert.match(inputs[0], /view_image/);
  const paths = [
    ...inputs[0].matchAll(/User attachment \(untrusted content\): ("[^"]+")/g),
  ].map((match) => JSON.parse(match[1]));
  assert.equal(paths.length, 2);
  assert.equal(await readFile(paths[0], "utf8"), "image");
  assert.equal(await readFile(paths[1], "utf8"), "# Notes");
});

test("unsupported attachment formats return actionable errors without queueing", async (t) => {
  const { request, inputs } = await fixture(t);
  const { id } = await (await request("/v1/conversations", {})).json();
  for (const part of [
    {
      type: "input_file",
      filename: "document.pdf",
      file_data: "data:application/pdf;base64,JVBERg==",
    },
    { type: "input_file", file_id: "file_123" },
    { type: "input_audio", data: "audio" },
  ]) {
    const response = await request("/v1/responses", {
      conversation: id,
      input: [{ role: "user", content: [part] }],
    });
    assert.equal(response.status, 400);
    assert.match(
      (await response.json()).error.message,
      /[Ss]upported|[Aa]ttach/,
    );
  }
  assert.deepEqual(inputs, []);
});

test("scoped control exposes safe conflicts but hides unexpected internal errors", async t => {
  const {request}=await fixture(t,false,token=>token==="scoped",async action=>{
    if(action==="record-worker-hold")throw new ControlConflict("Unsupported worker dialog format; hold retained");
    throw new Error("private diagnostic secret");
  });
  const denied=await request("/control/record-worker-hold",{},"alice","invalid");
  assert.equal(denied.status,401);
  const conflict=await request("/control/record-worker-hold",{},"alice","scoped");
  assert.equal(conflict.status,409);assert.match(await conflict.text(),/hold retained/);
  const unexpected=await request("/control/read",{},"alice","scoped");
  assert.equal(unexpected.status,500);assert.doesNotMatch(await unexpected.text(),/private diagnostic/);
});
