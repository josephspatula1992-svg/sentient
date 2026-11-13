export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;

/** yoctoNEAR (bigint or decimal string) as a short NEAR string. */
export function fmt(y: bigint | string | number, digits = 3): string {
  const v = typeof y === "bigint" ? y : BigInt(y);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / NEAR;
  const frac = ((abs % NEAR) * 10n ** BigInt(digits)) / NEAR;
  return `${neg ? "-" : ""}${whole}.${frac.toString().padStart(digits, "0")}`;
}

export const near = (n: number): bigint => BigInt(Math.round(n * 1e6)) * (NEAR / 1_000_000n);
