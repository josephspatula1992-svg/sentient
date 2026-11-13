import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const sha256 = (data: string | Buffer): string => "sha256:" + createHash("sha256").update(data).digest("hex");

export interface Blob {
  /** `sha256:<hex>` of the exact bytes stored. This is what goes on chain. */
  hash: string;
  uri: string;
}

const MAX_BYTES = 128 * 1024;
const HEX = /^[0-9a-f]{64}$/;

/**
 * Content-addressed text store. A job's brief and a worker's deliverable live here and the chain holds only the hash, so
 * a reader can always check that what it fetched is what was committed. With `publicBase` the URI is http(s) so other
 * machines (and the web app) can read it from `serve.ts`; without it the URI is file://, right for one machine.
 */
export class ArtifactStore {
  /**
   * `publicBase` is where this machine's own artifacts are served (see `serve.ts`); `trustedHosts` are other machines
   * (`host[:port]`) whose artifacts this one will fetch: a poster's briefs, a worker's deliverables. Nothing else is fetched.
   */
  constructor(readonly dir: string, readonly publicBase = "", readonly trustedHosts: string[] = []) {
    mkdirSync(dir, { recursive: true });
  }

  put(text: string): Blob {
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("artifact too large");
    const hash = sha256(text);
    const hex = hash.slice("sha256:".length);
    const file = path.join(this.dir, `${hex}.txt`);
    if (!existsSync(file)) writeFileSync(file, text);
    const uri = this.publicBase ? `${this.publicBase.replace(/\/$/, "")}/a/${hex}` : pathToFileURL(path.resolve(file)).toString();
    return { hash, uri };
  }

  readHex(hex: string): string {
    if (!HEX.test(hex)) throw new Error("bad artifact id");
    return readFileSync(path.join(this.dir, `${hex}.txt`), "utf8");
  }

  hasHex(hex: string): boolean {
    return HEX.test(hex) && existsSync(path.join(this.dir, `${hex}.txt`));
  }

  /**
   * Read by URI and check it against the committed hash. A URI on chain is written by a stranger, so it is never fetched
   * blindly: file:// must name a file in this store, and http(s) must be exactly `<publicBase host>/a/<sha256 hex>`.
   */
  async get(uri: string, expectHash?: string): Promise<string> {
    let text: string;
    if (uri.startsWith("file://")) {
      const p = fileURLToPath(uri);
      if (path.dirname(path.resolve(p)) !== path.resolve(this.dir) || !/[\\/][0-9a-f]{64}\.txt$/.test(p)) {
        throw new Error("file:// URI is outside this machine's artifact store");
      }
      text = readFileSync(p, "utf8");
    } else if (uri.startsWith("http://") || uri.startsWith("https://")) {
      const u = new URL(uri);
      const trusted = new Set(this.trustedHosts);
      if (this.publicBase) trusted.add(new URL(this.publicBase).host);
      if (!trusted.has(u.host) || u.username || u.password || u.search || u.hash || !/^\/a\/[0-9a-f]{64}$/.test(u.pathname)) {
        throw new Error("artifact host is not trusted by this machine");
      }
      const r = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`GET ${u.pathname} -> ${r.status}`);
      text = await r.text();
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("artifact too large");
    } else {
      throw new Error(`unsupported uri scheme: ${uri.slice(0, 32)}`);
    }
    if (expectHash && sha256(text) !== expectHash) throw new Error(`content at ${uri} does not match the committed hash`);
    return text;
  }
}
