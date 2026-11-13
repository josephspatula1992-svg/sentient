#!/usr/bin/env node
/**
 * One command, one video: serves the dashboard, opens it in headless Chrome, lets the guided tour play (captions, cursor, every
 * click), records the page, and writes an MP4.
 *
 *   npm run record                    # -> recordings/sentient-demo-<time>.mp4
 *   PACE=1.3 npm run record           # slower captions
 *   SHOW=1 npm run record             # also open the finished video
 *
 * It records the browser page itself (Chrome's own screencast of a headless window), not your screen, so you can keep using the
 * computer. It plays the recorded run in web/demo-run.json (the offline stand-in model; the README says so). Needs a built
 * project (`npm run build`), Chrome (set CHROME if it is not the macOS default) and ffmpeg. No other dependencies.
 *
 * Env: PORT (default: a free one), PACE (caption pace, default 1), WIDTH/HEIGHT (default 1400x900), OUT (output file),
 * MIN_FREE_MB (refuse to start below this much free disk, default 1500).
 * Adapted from the verity project's recorder.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = Number(process.env.WIDTH ?? 1400), H = Number(process.env.HEIGHT ?? 900);
const PACE = process.env.PACE ?? "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[record] ${m}`);

if (!existsSync(path.join(root, "dist/src/serve.js"))) throw new Error("run `npm run build` first");
if (!existsSync(path.join(root, "web/demo-run.json"))) throw new Error("web/demo-run.json is missing: run `npm run demo` once");
if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME=/path/to/chrome`);
if (spawnSync("ffmpeg", ["-version"]).status !== 0) throw new Error("ffmpeg is needed to make the video (brew install ffmpeg)");

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = Number(process.env.PORT ?? await freePort());
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.resolve(process.env.OUT ?? path.join(root, "recordings", `sentient-demo-${stamp}.mp4`));
mkdirSync(path.dirname(out), { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), "sentient-rec-"));
const profile = mkdtempSync(path.join(tmpdir(), "sentient-rec-chrome-"));

// Frames are written to disk as they arrive, so refuse to start on a nearly full disk rather than fill it.
const MIN_FREE_MB = Number(process.env.MIN_FREE_MB ?? 1500);
const freeKb = Number((spawnSync("df", ["-k", work], { encoding: "utf8" }).stdout.trim().split("\n").pop() ?? "").split(/\s+/)[3]);
if (Number.isFinite(freeKb) && freeKb / 1024 < MIN_FREE_MB) {
  rmSync(work, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true });
  throw new Error(`only ${(freeKb / 1024).toFixed(0)} MB free where frames are kept; free some space or set MIN_FREE_MB lower`);
}

let server = null, chrome = null;
// By handle, never by pattern: other sessions on this machine run their own servers and browsers.
const cleanup = () => {
  try { chrome?.kill("SIGKILL"); } catch { /* gone */ }
  try { server?.kill("SIGINT"); } catch { /* gone */ }
};
const tidy = () => {
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on("SIGINT", () => { cleanup(); tidy(); process.exit(130); });
process.on("exit", () => { cleanup(); tidy(); });

// 1. the dashboard
server = spawn("node", ["dist/src/serve.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(PORT), RPC_URL: "" } });
let log = "";
server.stdout.on("data", (d) => { log += d; });
server.stderr.on("data", (d) => { log += d; });
const t0 = Date.now();
while (!/Sentient dashboard at/.test(log)) {
  if (server.exitCode !== null) throw new Error(`the server exited early:\n${log.slice(-800)}`);
  if (Date.now() - t0 > 30000) throw new Error(`the server did not come up:\n${log.slice(-800)}`);
  await sleep(200);
}
const URL_ = `http://localhost:${PORT}`;
say(`dashboard up at ${URL_}`);

// 2. a browser we can talk to
const dbg = 9400 + Math.floor(Math.random() * 400);
chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--hide-scrollbars", `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
let tabs = [];
for (let i = 0; i < 60 && !tabs.length; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json(); } catch { await sleep(250); } }
const page = tabs.find((t) => t.type === "page");
if (!page) throw new Error("could not reach the browser's debugging port");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let msgId = 0;
const pending = new Map();
const frames = [];
let frameN = 0;
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
  else if (msg.method === "Page.screencastFrame") {
    const { data, metadata, sessionId } = msg.params;
    send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    // 30 frames a second in the video: a frame less than a thirtieth of a second after the last kept one is never seen
    if (frames.length && metadata.timestamp - frames[frames.length - 1].t < 0.033) return;
    const file = path.join(work, `f${String(++frameN).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
  }
});
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

// 3. record while the tour plays
await send("Page.startScreencast", { format: "jpeg", quality: 82, everyNthFrame: 1 });
say("recording ...");
await send("Page.navigate", { url: `${URL_}/?tour=1&pace=${PACE}` });

let last = "", captions = 0, finished = false;
const deadline = Date.now() + 25 * 60 * 1000;
while (Date.now() < deadline) {
  await sleep(1000);
  let s = {};
  try { s = JSON.parse(await evalJs(`JSON.stringify({ done: window.__tourDone ?? "", cap: document.querySelector('#tour-caption')?.innerText ?? document.querySelector('.tour-caption.on')?.innerText ?? '' })`)); } catch { /* page still loading */ }
  if (s.cap && s.cap !== last) { last = s.cap; captions++; say(`  ${s.cap.replace(/\s+/g, " ").slice(0, 90)}`); }
  if (s.done) {
    if (s.done !== "finished") throw new Error(`the tour ${s.done}`);
    finished = true;
    break;
  }
}
if (!finished) throw new Error("the tour did not finish within 25 minutes");
await sleep(2500); // the closing card holds
await send("Page.stopScreencast");
await sleep(500);
ws.close();
cleanup();
say(`captured ${frames.length} frames; encoding ...`);

// 4. frames -> video. The screencast sends a frame only when the page changes, so each frame is shown until the next one.
if (frames.length < 10) throw new Error(`only ${frames.length} frames were captured; the page did not render`);
const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, ((frames[i + 1]?.t ?? f.t + 2) - f.t)).toFixed(4)}`).join("\n") + `\nfile '${frames[frames.length - 1].file}'\n`;
writeFileSync(path.join(work, "frames.txt"), list);
const enc = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(work, "frames.txt"),
  "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", out], { encoding: "utf8" });
if (enc.status !== 0) throw new Error(`ffmpeg failed: ${enc.stderr}`);
const secs = (frames[frames.length - 1].t - frames[0].t).toFixed(0);
say(`done: ${out}  (${secs}s, ${captions} captions seen)`);
if (process.env.SHOW === "1") spawn("open", [out], { stdio: "ignore", detached: true }).unref();
process.exit(0);
