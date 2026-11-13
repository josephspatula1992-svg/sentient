/**
 * Serves the dashboard (web/) and, at /a/<sha256 hex>, any content-addressed artifact in the store. Read-only: there is no
 * write route, so nothing a visitor sends can change anything here.
 *
 *   npm run serve            # http://localhost:8788
 *   PORT=9000 STORE_DIR=store-demo npm run serve
 *   RPC_URL=http://127.0.0.1:3030 npm run serve   # also forwards READ-ONLY queries at POST /rpc, for a node without CORS
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// this file runs from dist/src, so the project root is two levels up
const root = path.resolve(here, "../..");
const WEB = path.join(root, "web");
const STORE = path.resolve(process.env.STORE_DIR ?? path.join(root, "store-demo"));
const PORT = Number(process.env.PORT ?? 8788);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8",
};

const HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src *; base-uri 'none'; form-action 'none'",
};

/** The only JSON-RPC queries the proxy forwards: reads. Nothing that signs, sends or changes state gets through. */
const READ_ONLY_QUERIES = new Set(["call_function", "view_account", "view_access_key", "view_access_key_list", "view_state"]);

async function proxyRpc(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, upstream: string) {
  // Read with listeners, not `for await`: leaving that loop early destroys the request, which can drop the response we are
  // about to send. Past the limit the rest of the body is ignored and the socket is closed once the 413 has gone out.
  const raw = await new Promise<Buffer | "too-large" | "error">((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (v: Buffer | "too-large" | "error") => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    req.on("data", (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > 64 * 1024) settle("too-large");
      else chunks.push(c);
    });
    req.on("end", () => settle(Buffer.concat(chunks)));
    req.on("error", () => settle("error"));
  });
  if (raw === "too-large") {
    res.once("finish", () => req.destroy());
    res.writeHead(413, { connection: "close", ...HEADERS }).end("too large");
    return;
  }
  if (raw === "error") {
    res.writeHead(400, HEADERS).end("could not read the request");
    return;
  }
  let body: { method?: string; params?: { request_type?: string } } | null;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    res.writeHead(400, HEADERS).end("bad json");
    return;
  }
  // JSON `null`, a number or an array is valid JSON but not a query
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    res.writeHead(400, HEADERS).end("expected a JSON-RPC object");
    return;
  }
  if (body.method !== "query" || !READ_ONLY_QUERIES.has(body.params?.request_type ?? "")) {
    res.writeHead(403, HEADERS).end("this proxy forwards read-only queries only");
    return;
  }
  try {
    const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    res.writeHead(r.status, { "content-type": "application/json", ...HEADERS }).end(text);
  } catch {
    // say so, instead of the generic 404 the outer handler would give
    res.writeHead(502, HEADERS).end("the node did not answer");
  }
}

/**
 * `rpcUrl` is the node the /rpc route forwards reads to: pass a URL, or `null` for none. It defaults to $RPC_URL.
 */
export function startServer(port = PORT, rpcUrl: string | null | undefined = process.env.RPC_URL, storeDir: string = STORE) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/rpc") {
        if (!rpcUrl) {
          res.writeHead(404, HEADERS).end("no upstream node configured (set RPC_URL)");
          return;
        }
        return await proxyRpc(req, res, rpcUrl);
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD", ...HEADERS }).end("read-only");
        // (the one POST route, /rpc, is handled above and forwards reads only)
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      let file: string;
      const art = /^\/a\/([0-9a-f]{64})$/.exec(url.pathname);
      if (art) {
        file = path.join(storeDir, `${art[1]}.txt`);
      } else {
        const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
        file = path.resolve(WEB, rel);
        if (file !== WEB && !file.startsWith(WEB + path.sep)) {
          res.writeHead(403, HEADERS).end("forbidden");
          return;
        }
      }
      const s = await stat(file);
      if (!s.isFile()) throw new Error("not a file");
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": art ? "text/plain; charset=utf-8" : TYPES[path.extname(file)] ?? "application/octet-stream",
        "content-length": body.length,
        "cache-control": art ? "public, max-age=31536000, immutable" : "no-cache",
        ...HEADERS,
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404, HEADERS).end("not found");
    }
  });
  return new Promise<ReturnType<typeof createServer>>((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startServer();
  console.log(`Sentient dashboard at http://localhost:${PORT}`);
  if (process.env.RPC_URL) console.log(`read-only node proxy at http://localhost:${PORT}/rpc -> ${process.env.RPC_URL}`);
}
