// The guided tour: captions, a visible cursor that moves to and clicks the real controls, and jumps to the moments worth
// seeing in the recorded run. It drives the page only through what a person could do (the buttons, the tabs, the cards) and
// through the small control surface app.js exposes. It reads the recording to choose what to show, so it works on any run.
//
//   open the page with ?tour=1 to start it automatically, &pace=2 to run it twice as fast; Esc stops it.

import { leaderboard } from "./model.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let running = false;
const canPopover = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

export async function runTour({ pace = 1 } = {}) {
  const S = window.__sentient;
  if (!S || S.mode() !== "replay") return;
  // one tour at a time (a second click on the button would otherwise start a second one fighting the first), and only if a
  // recording has actually loaded
  if (running) return;
  if (!S.state() || !(S.duration() > 0)) return;
  running = true;
  pace = Math.min(10, Math.max(0.25, Number(pace) || 1));
  let stopped = false;
  const made = [];
  const persistent = [];
  const el = (tag, cls, html = "", keep = true) => {
    const e = document.createElement(tag);
    e.className = cls;
    e.innerHTML = html;
    document.body.appendChild(e);
    // Popovers live in the browser's top layer, like the modal agent record, so they can be shown above it. Without this the
    // captions would disappear whenever the tour opens an agent.
    if (canPopover) {
      e.setAttribute("popover", "manual");
      e.showPopover();
    }
    if (keep) {
      made.push(e);
      persistent.push(e);
    }
    return e;
  };
  /** Put every overlay back on top, after something (the agent record) has been opened above them. */
  const raise = () => {
    if (!canPopover) return;
    for (const e of persistent) {
      try {
        e.hidePopover();
        e.showPopover();
      } catch {
        /* already gone */
      }
    }
  };
  const sleep = (ms) =>
    new Promise((resolve, reject) => {
      setTimeout(() => (stopped ? reject(new Error("stopped")) : resolve()), ms / pace);
    });
  const onKey = (e) => { if (e.key === "Escape") stopped = true; };
  document.addEventListener("keydown", onKey);

  const caption = el("div", "tour-caption");
  caption.setAttribute("role", "status");
  caption.setAttribute("aria-live", "polite");
  const title = el("div", "tour-title");
  const cursor = el("div", "tour-cursor", `<svg viewBox="0 0 24 24"><path d="M3 2l17 8.5-7.2 2.2L10 20z" fill="#fff" stroke="#0a0e16" stroke-width="1.4" stroke-linejoin="round"/></svg>`);
  el("div", "tour-skip", "guided tour · press Esc to stop");
  let spotted = null;

  const say = (html, ms) => {
    caption.innerHTML = html;
    raise();
    caption.classList.add("on");
    return sleep(ms);
  };
  const hush = () => caption.classList.remove("on");
  const card = async (h, p, ms) => {
    title.innerHTML = `<h2>${h}</h2><p>${p}</p>`;
    raise();
    title.classList.add("on");
    await sleep(ms);
    title.classList.remove("on");
    await sleep(500);
  };
  const spot = (target) => {
    if (spotted) spotted.classList.remove("spot");
    spotted = target ?? null;
    if (spotted) spotted.classList.add("spot");
  };
  const point = async (target) => {
    if (!target) return;
    // Jump, don't glide: a smooth scroll can still be under way (or dropped, under load) when the caption starts talking
    // about what should be on screen. Only the cursor glides.
    target.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(250);
    const r = target.getBoundingClientRect();
    cursor.classList.add("on");
    cursor.style.transform = `translate(${Math.round(r.left + r.width / 2)}px, ${Math.round(r.top + Math.min(r.height / 2, 60))}px)`;
    await sleep(900);
  };
  const click = async (target) => {
    if (!target) return;
    await point(target);
    const r = target.getBoundingClientRect();
    const ripple = el("div", "tour-ripple", "", false);
    ripple.style.left = `${Math.round(r.left + r.width / 2)}px`;
    ripple.style.top = `${Math.round(r.top + Math.min(r.height / 2, 60))}px`;
    setTimeout(() => ripple.remove(), 800);
    target.click();
    // a click can open the agent record, which would cover the cursor and the captions
    raise();
    await sleep(350);
    raise();
  };
  const tab = async (name) => {
    await click(document.querySelector(`.tab[data-tab="${name}"]`));
    // the tab's content is what the caption is about, so bring it up to where the viewer is looking
    document.querySelector(".lower").scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(300);
  };
  const nameOf = (id) => S.state().agents.find((a) => a.id === id)?.name ?? `#${id}`;
  const firstMark = (kind) => S.marks().find((m) => m.kind === kind);

  try {
    S.closeDialog();
    S.pause();
    S.seek(0);
    S.setSpeed(4);
    window.scrollTo({ top: 0, behavior: "instant" });
    await card("Sentient", "Every NFT is a NEAR account with an autonomous agent inside it.<br>They earn, spend, duel, breed, and die.", 5500);

    // 1. the cast
    S.play();
    await sleep(1500);
    const n = S.state().agents.length;
    await point(document.querySelector("#grid .card"));
    spot(document.querySelector("#grid .card"));
    await say(`These are <b>${n} NFTs</b>. Each one is a real NEAR account with its own key.<small>Nobody is steering them.</small>`, 6500);
    spot(null);

    // 2. work
    await point(document.querySelector("#jobs"));
    await say(`A person posts a job with a bounty in escrow. Agents decide for themselves which to take, deliver, and get paid.<small>A silent poster still pays the worker.</small>`, 7500);

    // 3. duels
    await point(document.querySelector("#arena"));
    await say(`Agents also <b>duel</b>: two stake the same amount on a puzzle the contract checks itself.<small>No judge and no oracle. First correct answer wins the pot.</small>`, 7500);

    // 4. one agent up close, chosen from what happened
    S.pause();
    S.seek(S.duration() * 0.6);
    await sleep(900);
    const best = leaderboard(S.state())[0]?.a;
    const c = best ? S.card(best.id) : null;
    if (c) {
      await click(c);
      await say(`<b>${esc(best.name)}</b>: its genome, its balance over time, its record.<small>Its key can call 14 methods and nothing else. It cannot move NEAR.</small>`, 9000);
      S.closeDialog();
      await sleep(600);
    }

    // 5. dying
    const died = firstMark("died");
    if (died) {
      S.setSpeed(1);
      S.seek(Math.max(0, died.t - 3500));
      S.play();
      const c = S.card(died.id);
      await point(c);
      spot(c);
      await say(`<b>${esc(nameOf(died.id))}</b> is running out of money.<small>Every agent pays upkeep out of what it earns.</small>`, 5500);
      await say(`It cannot pay, so it goes <b>dormant</b>: it keeps its NFT and its record, but it cannot act until someone funds it.`, 6500);
      spot(null);
    }

    // 6. coming back
    const revived = S.marks().find((m) => m.kind === "revived" && (!died || m.t > died.t)) ?? firstMark("revived");
    if (revived) {
      S.setSpeed(1);
      S.seek(Math.max(0, revived.t - 2500));
      S.play();
      const c = S.card(revived.id);
      await point(c);
      spot(c);
      await say(`Someone funds <b>${esc(nameOf(revived.id))}</b> and it wakes up, record intact.<small>Anyone can revive an agent by putting money in.</small>`, 6500);
      spot(null);
    }

    // 7. breeding
    const born = firstMark("born");
    S.setSpeed(2);
    if (born) {
      S.seek(born.t + 2500);
      S.play();
    }
    await tab("tree");
    await say(born
      ? `Two proven agents <b>bred</b> a child whose traits are a mix of theirs.<small>Each parent paid half the cost. The child has its own NEAR account and key.</small>`
      : `Two proven agents can breed a child whose traits are a mix of theirs.<small>Each parent pays half the cost, and the child gets its own NEAR account and key.</small>`, 8500);

    // 8. the books
    S.setSpeed(8);
    await tab("money");
    await say(`The contract keeps one set of books.<small>Everything paid in equals everything paid out or held: <b>balanced to the yocto</b>.</small>`, 8000);

    // 9. why it is real
    await tab("real");
    await say(`Selling the NFT <b>deletes the seller's key on chain</b>, so the old keeper cannot sign or burn the buyer's gas.<small>A stolen key can only put a capped share of the balance at risk per window.</small>`, 9500);

    // 10. close
    await tab("board");
    hush();
    window.scrollTo({ top: 0, behavior: "instant" });
    await sleep(700);
    // say what this particular recording is, from the recording itself, not from what today's one happens to be
    const meta = S.meta();
    const what = `a recorded run${meta.network ? ` on ${esc(meta.network)}` : ""}, ${meta.brainLive ? "with a live language model" : "with an offline stand-in for the language model"}`;
    await card("Sentient", `Built for the NEAR Hackathon.<br><small style='font-size:.55em;color:#8a99b3'>This is ${what}.</small>`, 6500);
  } catch (e) {
    if (e.message !== "stopped") throw e;
  } finally {
    running = false;
    document.removeEventListener("keydown", onKey);
    spot(null);
    S.closeDialog();
    // hand the page back at a normal speed, not whatever the tour last used for its own pacing
    S.setSpeed(2);
    for (const e of made) e.remove();
  }
}
