// usage: node rpc.mjs <tool> [port] < args.json   — prints the tool result (text parts as-is, images summarized)
const tool = process.argv[2];
const port = Number(process.argv[3] || 47800);
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const args = raw.trim() ? JSON.parse(raw) : {};
const t0 = Date.now();
const res = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }) });
const text = await res.text();
let body;
try { body = JSON.parse(text); } catch { console.log(`HTTP ${res.status} (non-JSON): ${text.slice(0, 2000)}`); process.exit(1); }
console.log(`HTTP ${res.status} in ${Date.now() - t0} ms${body.isError ? ' [isError]' : ''}`);
for (const part of body.content ?? []) {
  if (part.type === 'text') console.log(part.text);
  else if (part.type === 'image') console.log(`[image ${part.mimeType} base64 ${part.data.length} chars]`);
  else console.log(JSON.stringify(part).slice(0, 500));
}
if (!body.content) console.log(JSON.stringify(body, null, 1).slice(0, 4000));
