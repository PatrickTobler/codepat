// Persist only fixed, recognized API rejection categories, never response text.
export async function apiRejection(response: Response): Promise<string | undefined> {
  if (response.status !== 422 || !response.body) return undefined;
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let size=0;
  try {
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.length;
      if(size>16384)return undefined;
      chunks.push(value);
    }
    const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if(!body || typeof body!=="object")return undefined;
    if(body.message==="Invalid status transition: same status")return "same_status";
    if(body.kind==="queued_requires_schedule")return "queued_requires_schedule";
    // This API response can include a committed pause event: rejection of the
    // requested action does not imply absence of remote side effects.
    if(body.kind==="insufficient_balance")return "insufficient_balance";
  }catch { /* Invalid/missing bodies leave the verified HTTP status intact. */ }
  finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
  return undefined;
}
