export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const log = (who: string, msg: string) => {
  if (process.env.QUIET) return;
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${who.padEnd(14)} ${msg}`);
};

const lastShown = new Map<string, number>();

/**
 * Show an unexpected failure by default, but the same message from the same source at most once a minute. A loop that fails
 * the same way every second (no gas, a key the contract no longer honours) would otherwise be invisible without VERBOSE, or
 * a flood with it.
 */
export const logError = (who: string, msg: string, everyMs = 60_000, now = Date.now()) => {
  const key = `${who}|${msg}`;
  const prev = lastShown.get(key);
  if (prev !== undefined && now - prev < everyMs) return false;
  lastShown.set(key, now);
  log(who, `error: ${msg}`);
  return true;
};
