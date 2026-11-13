import type { Chain } from "./near.js";
import type { Agent, Audit, Config, Duel, FeedEntry, Job, Stats } from "./types.js";

export interface Snapshot {
  /** wall-clock ms when this was read */
  at: number;
  agents: Agent[];
  jobs: Job[];
  duels: Duel[];
  feed: FeedEntry[];
  stats: Stats;
}

/**
 * One poller for everyone. A dozen agents asking the node the same questions every second would only slow each other
 * down, so they read this snapshot and use their own accounts only to write.
 */
export class WorldWatcher {
  snap: Snapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  readonly listeners: Array<(s: Snapshot) => void> = [];

  constructor(private readonly chain: Chain, private readonly everyMs = 800, readonly cfg?: Config) {}

  async refresh(): Promise<Snapshot> {
    const [agents, jobs, duels, feed, stats] = await Promise.all([
      this.chain.agents(1, 100),
      this.chain.recentJobs(60),
      this.chain.recentDuels(60),
      this.chain.feed(80),
      this.chain.stats(),
    ]);
    this.snap = { at: Date.now(), agents, jobs, duels, feed, stats };
    for (const l of this.listeners) l(this.snap);
    return this.snap;
  }

  start(): void {
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.refresh();
      } catch {
        /* a missed poll is simply the next one */
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.everyMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** The chain's idea of now, in seconds, advanced by the time since the last poll. */
  chainNow(): number {
    if (!this.snap) return Math.floor(Date.now() / 1000);
    return this.snap.stats.now + (Date.now() - this.snap.at) / 1000;
  }

  agent(id: number): Agent | undefined {
    return this.snap?.agents.find((a) => a.id === id);
  }

  async audit(): Promise<Audit> {
    return this.chain.audit();
  }
}
