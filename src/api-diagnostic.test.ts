import assert from "node:assert/strict";
import test from "node:test";
import {apiRejection} from "./api-diagnostic.ts";
test("API rejection diagnostics allow only fixed contract categories",async()=>{
  for(const [body,expected] of [
    [{message:"Invalid status transition: same status",private:"PRIVATE"},"same_status"],
    [{kind:"queued_requires_schedule"},"queued_requires_schedule"],
    [{kind:"insufficient_balance",data:{private:"PRIVATE"}},"insufficient_balance"],
    [{message:"PRIVATE",kind:"PRIVATE"},undefined],
    [{message:"Invalid status transition: same status PRIVATE"},undefined],
    [null,undefined],
  ] as const)assert.equal(await apiRejection(new Response(JSON.stringify(body),{status:422})),expected);
  assert.equal(await apiRejection(new Response("not JSON",{status:422})),undefined);
  assert.equal(await apiRejection(new Response(JSON.stringify({kind:"insufficient_balance"}),{status:500})),undefined);
});
test("oversized or interrupted rejection bodies retain no diagnostic",async()=>{
  let cancelled=false;
  const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(17000));},cancel(){cancelled=true;}});
  assert.equal(await apiRejection(new Response(stream,{status:422})),undefined);assert.equal(cancelled,true);
  const broken=new ReadableStream({start(controller){controller.error(new Error("PRIVATE"));}});
  assert.equal(await apiRejection(new Response(broken,{status:422})),undefined);
});
