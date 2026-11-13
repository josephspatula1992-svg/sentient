import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/serve.js";

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, () => r((s.address() as AddressInfo).port)));

test("the dashboard server forwards read-only queries to the node and nothing else", async () => {
  const seen: unknown[] = [];
  const upstream = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d)).on("end", () => {
      seen.push(JSON.parse(b));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    });
  });
  const upPort = await listen(upstream);
  const web = await startServer(0, `http://127.0.0.1:${upPort}`);
  const port = (web.address() as AddressInfo).port;
  const post = (path: string, body: string) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  try {
    const q = (request_type: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type, account_id: "x.near" } });
    for (const t of ["call_function", "view_account", "view_access_key_list"]) {
      const r = await post("/rpc", q(t));
      assert.equal(r.status, 200, t);
      assert.deepEqual(await r.json(), { jsonrpc: "2.0", id: 1, result: { ok: true } });
    }
    assert.equal(seen.length, 3);
    // anything that could sign, send or change state is refused before it reaches the node
    for (const body of [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "broadcast_tx_commit", params: ["abc"] }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "send_tx", params: { signed_tx_base64: "abc" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "EXPERIMENTAL_changes" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: {} }),
    ]) {
      assert.equal((await post("/rpc", body)).status, 403, body);
    }
    assert.equal((await post("/rpc", "not json")).status, 400);
    for (const odd of ["null", "7", "[]", '[{"method":"query"}]']) assert.equal((await post("/rpc", odd)).status, 400, odd);
    assert.equal((await post("/rpc", "x".repeat(70_000))).status, 413);
    assert.equal(seen.length, 3, "nothing refused was forwarded");
    // the rest of the server stays read-only
    assert.equal((await post("/", "{}")).status, 405);
    assert.equal((await fetch(`http://127.0.0.1:${port}/..%2f..%2fpackage.json`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  } finally {
    web.close();
    upstream.close();
  }
});

test("a node that is down is a 502, not a vague 404", async () => {
  const web = await startServer(0, "http://127.0.0.1:1");
  const port = (web.address() as AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/rpc`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account" } }) });
    assert.equal(r.status, 502);
  } finally {
    web.close();
  }
});

test("without an upstream node the proxy route does not exist", async () => {
  const web = await startServer(0, null);
  const port = (web.address() as AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/rpc`, { method: "POST", body: "{}" });
    assert.equal(r.status, 404);
  } finally {
    web.close();
  }
});
