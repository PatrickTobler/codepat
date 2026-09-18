// Optional read-only compatibility probe against a Sokosumi checkout.
// Run with that checkout's tsx: tsx scripts/verify-sokosumi-stream.ts /absolute/path/to/responses-sse-to-v4-stream.ts
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
async function main() {
  if (!process.argv[2]) throw new Error("Supply the Sokosumi parser source path");
  const { createResponsesSseToV4Stream } = await import(pathToFileURL(process.argv[2]).href);
  let send!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({start(c) { send = c; }});
  const stream = createResponsesSseToV4Stream(source, {warnings: []});
  const reader = stream.getReader();
  const observed: Array<Record<string, unknown>> = [];
  const consume = (async () => { for (;;) { const r = await reader.read(); if(r.done) return; observed.push(r.value); }})();
  const frame = (value: unknown) => send.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
  frame({type:'response.created',response:{id:'resp_synthetic'}});
  frame({type:'response.reasoning_summary_text.delta',item_id:'progress_synthetic',delta:'Checking the example.\n\n'});
  frame({type:'response.output_item.done',item:{id:'progress_synthetic',type:'reasoning',summary:[{type:'summary_text',text:'Checking the example.\n\n'}]}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(observed.some(item => item.type === "reasoning-delta"));
  assert.ok(!observed.some(item => item.type === "text-delta" || item.type === "finish"));
  console.log('Before completion:',JSON.stringify(observed));
  frame({type:'response.output_text.delta',delta:'Final answer.'});
  frame({type:'response.completed',response:{id:'resp_synthetic',status:'completed'}});
  await consume;
  assert.equal(observed.filter(item => item.type === "reasoning-delta").length, 1);
  assert.equal(observed.find(item => item.type === "text-delta")?.delta, "Final answer.");
  assert.equal(observed.at(-1)?.type, "finish");
  console.log('After completion:',JSON.stringify(observed));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
