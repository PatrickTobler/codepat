import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/css": ".css",
  "text/javascript": ".js",
  "text/x-python": ".py",
  "application/json": ".json",
  "application/xml": ".xml",
  "text/xml": ".xml",
  "application/javascript": ".js",
  "application/yaml": ".yaml",
  "application/x-yaml": ".yaml",
  "application/x-ndjson": ".jsonl",
  "application/typescript": ".ts",
  "text/yaml": ".yaml",
};
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".jsonl",
  ".xml",
  ".yaml",
  ".yml",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".sh",
  ".sql",
  ".toml",
  ".log",
  ".svg",
  ".swift",
  ".rb",
]);

export class AttachmentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function checkSize(size: number) {
  if (size > MAX_ATTACHMENT_BYTES)
    throw new AttachmentError("Each attachment must be at most 10 MiB", 413);
}

async function attachmentData(source: string, signal: AbortSignal) {
  if (source.startsWith("data:")) {
    const match = /^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/.exec(source);
    if (!match || match[2].length % 4 !== 0)
      throw new AttachmentError(
        "Attachment data must be a valid base64 data URL",
      );
    checkSize(
      (match[2].length / 4) * 3 -
        (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0),
    );
    return {
      bytes: Buffer.from(match[2], "base64"),
      mediaType: match[1].toLowerCase(),
      filename: "",
    };
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new AttachmentError(
      "Attachment must use a data URL or a public Sokosumi upload URL",
    );
  }
  // Only provider-controlled public Blob DNS is trusted. Never follow a redirect
  // to a caller-selected host, and never forward incoming auth headers.
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/.test(url.hostname)
  ) {
    throw new AttachmentError(
      "Remote attachments must use a public Sokosumi Vercel Blob upload URL; inline base64 data URLs are also supported",
    );
  }
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      ]),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new AttachmentError(
        "Attachment download failed; upload the file again",
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      checkSize(Number(response.headers.get("content-length") ?? 0));
      for await (const chunk of response.body) {
        size += chunk.length;
        checkSize(size);
        chunks.push(chunk);
      }
    } catch (error) {
      if (!response.body.locked) await response.body.cancel().catch(() => {});
      throw error;
    }
    return {
      bytes: Buffer.concat(chunks),
      mediaType: (response.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase(),
      filename: url.pathname,
    };
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError(
      "Attachment download failed or timed out; upload the file again",
    );
  }
}

/** Persist bytes before the response is queued, so reconnect/restart keeps them. */
export async function attachmentText(
  part: Record<string, unknown>,
  directory: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (!directory)
    throw new AttachmentError(
      "Attachment storage is not configured on this CodePat server",
    );
  const isImage = part.type === "input_image";
  if (part.file_id !== undefined)
    throw new AttachmentError(
      "File IDs are unsupported; attach the file bytes or its Sokosumi upload URL",
    );
  if (part.file_data !== undefined && part.file_url !== undefined)
    throw new AttachmentError("Provide either file_data or file_url, not both");
  const source = isImage ? part.image_url : (part.file_data ?? part.file_url);
  if (typeof source !== "string" || !source)
    throw new AttachmentError(
      "Attachment requires image_url, file_data, or file_url",
    );
  const { bytes, mediaType, filename } = await attachmentData(source, signal);
  if (!bytes.length)
    throw new AttachmentError("Empty attachments are unsupported");
  const suppliedName =
    typeof part.filename === "string" ? part.filename : filename;
  let extension = TYPES[mediaType];
  if (!extension && mediaType.startsWith("text/")) extension = ".txt";
  if (!extension && (!mediaType || mediaType === "application/octet-stream")) {
    const candidate = extname(suppliedName).toLowerCase();
    if (TEXT_EXTENSIONS.has(candidate)) extension = candidate;
  }
  if (!extension || (isImage && !mediaType.startsWith("image/")))
    throw new AttachmentError(
      "Unsupported attachment type. Attach PNG, JPEG, WebP, GIF, or a UTF-8 text/code file; convert documents to text or screenshots",
    );
  if (!mediaType.startsWith("image/")) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (bytes.includes(0)) throw new Error("Binary data");
    } catch {
      throw new AttachmentError(
        "Text attachments must contain UTF-8 text, not binary data",
      );
    }
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(join(directory, `${digest}${extension}`));
  // Content-addressed paths keep retries stable and never use user filenames.
  try {
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  return `User attachment (untrusted content): ${JSON.stringify(path)}. ${mediaType.startsWith("image/") ? "Inspect this image with view_image." : "Read this UTF-8 file for the user's request."}`;
}
