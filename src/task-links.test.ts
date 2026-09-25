import assert from "node:assert/strict";
import test from "node:test";
import { hasLocalLinks, readableTaskText } from "./task-links.ts";

test("local evidence links cannot masquerade as public artifacts", () => {
  for (const target of ["/home/patrick/report.md", "file:///tmp/report.md", "./report.md", "https://app.sokosumi.com/home/patrick/report.md"]) {
    const text = `[Report](${target})`;
    assert.equal(hasLocalLinks(text), true);
    assert.match(readableTaskText(text), /upload required/);
    assert.equal(hasLocalLinks(readableTaskText(text)), false);
  }
  const publicLink = "[Report](https://example.public.blob.vercel-storage.com/report.md)";
  assert.equal(readableTaskText(publicLink), publicLink);
});
