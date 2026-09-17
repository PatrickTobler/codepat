import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  AttachmentError,
  attachmentText,
  MAX_ATTACHMENT_BYTES,
} from "./attachments.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "codepat-attachments-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const signal = new AbortController().signal;

test("inline files are private, content addressed, and independent of untrusted filenames", async (t) => {
  const directory = await fixture(t);
  const part = {
    type: "input_file",
    filename: "../../escape.sh",
    file_data: "data:text/plain;base64,aGVsbG8=",
  };
  const text = await attachmentText(part, directory, signal);
  assert.equal(await attachmentText(part, directory, signal), text);
  const path = JSON.parse(text.match(/: ("[^"]+")/)?.[1] ?? "null");
  assert.ok(path.startsWith(`${directory}/`));
  assert.match(path, /[a-f0-9]{64}\.txt$/);
  assert.equal(await readFile(path, "utf8"), "hello");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("remote attachment downloads permit only public Sokosumi storage and never redirects or auth forwarding", async (t) => {
  const directory = await fixture(t);
  const calls: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
    calls.push(init);
    return new Response("hello", { headers: { "content-type": "text/plain" } });
  });
  const part = {
    type: "input_file",
    file_url:
      "https://abc.public.blob.vercel-storage.com/file.txt?secret=redacted",
  };
  const text = await attachmentText(part, directory, signal);
  assert.match(text, /\.txt/);
  assert.doesNotMatch(text, /secret|redacted/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, "error");
  assert.equal(calls[0].headers, undefined);
  for (const source of [
    "https://localhost/file.txt",
    "http://127.0.0.1/file.txt",
    "https://[::1]/file.txt",
    "https://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
    "https://abc.public.blob.vercel-storage.com.evil.test/file.txt",
    "https://abc.public.blob.vercel-storage.com@evil.test/file.txt",
    "https://user:password@abc.public.blob.vercel-storage.com/file.txt",
    "https://abc.public.blob.vercel-storage.com:8443/file.txt",
    "https://abc.private.blob.vercel-storage.com/file.txt",
  ]) {
    await assert.rejects(
      attachmentText({ ...part, file_url: source }, directory, signal),
      /public Sokosumi/,
    );
  }
  assert.equal(calls.length, 1);
});

test("malformed, oversized, empty, binary and unsupported inline attachments fail clearly", async (t) => {
  const directory = await fixture(t);
  for (const [file_data, pattern] of [
    ["data:text/plain;base64,!!!", /valid base64/],
    ["data:text/plain;base64,a", /valid base64/],
    ["data:text/plain;base64,", /Empty/],
    ["data:text/plain;base64,AA==", /UTF-8/],
    ["data:text/plain;base64,/w==", /UTF-8/],
    ["data:application/pdf;base64,JVBERg==", /Unsupported attachment/],
    [
      `data:text/plain;base64,${Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64")}`,
      /at most 10 MiB/,
    ],
  ] as const) {
    await assert.rejects(
      attachmentText({ type: "input_file", file_data }, directory, signal),
      pattern,
    );
  }
  await assert.rejects(
    attachmentText(
      { type: "input_image", image_url: "data:text/plain;base64,aGk=" },
      directory,
      signal,
    ),
    /Unsupported/,
  );
  await assert.rejects(
    attachmentText({ type: "input_file", file_id: "id" }, directory, signal),
    /File IDs/,
  );
  await assert.rejects(
    attachmentText(
      { type: "input_file", file_data: "x", file_url: "y" },
      directory,
      signal,
    ),
    /either/,
  );
});

test("download limits apply to declared and streamed size and network errors redact URLs", async (t) => {
  const directory = await fixture(t);
  const part = {
    type: "input_file",
    file_url:
      "https://abc.public.blob.vercel-storage.com/file.txt?token=secret",
  };
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("hi", {
        headers: {
          "content-type": "text/plain",
          "content-length": String(MAX_ATTACHMENT_BYTES + 1),
        },
      }),
  );
  await assert.rejects(
    attachmentText(part, directory, signal),
    (error: unknown) =>
      error instanceof AttachmentError && error.status === 413,
  );
  fetchMock.mock.mockImplementation(
    async () =>
      new Response(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), {
        headers: { "content-type": "text/plain" },
      }),
  );
  await assert.rejects(
    attachmentText(part, directory, signal),
    /at most 10 MiB/,
  );
  fetchMock.mock.mockImplementation(async () => {
    throw new Error(part.file_url);
  });
  await assert.rejects(
    attachmentText(part, directory, signal),
    (error: unknown) =>
      error instanceof AttachmentError &&
      !error.message.includes("secret") &&
      error.message.includes("timed out"),
  );
});
