/* Narrated console logging for the DAX demo. Every request prints what
 * happened: the operation, where it was served (DAX cache vs DynamoDB), and
 * how long it took.
 *
 * NOTE: DAX does not expose a hit/miss flag on the response. We INFER it from
 * latency — a cache hit is typically sub-millisecond, a miss (DAX -> DynamoDB)
 * is several ms. The threshold is HIT_THRESHOLD_MS. Use `?compare=1` on a read
 * to also time a direct (uncached) DynamoDB call for a side-by-side baseline. */

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

const HIT_THRESHOLD_MS = Number(process.env.HIT_THRESHOLD_MS ?? 2);

export function request(method: string, path: string): void {
  console.log(`\n${C.cyan}${C.bold}▶ ${method} ${path}${C.reset}`);
}

export function step(text: string): void {
  console.log(`  ${C.gray}↳${C.reset} ${text}`);
}

/** Logs a DAX read and returns the inferred result. */
export function daxRead(op: string, ms: number): "HIT" | "MISS" {
  const hit = ms <= HIT_THRESHOLD_MS;
  const tag = hit
    ? `${C.green}cache HIT${C.reset}`
    : `${C.yellow}likely MISS → DynamoDB${C.reset}`;
  console.log(
    `  ${C.gray}↳${C.reset} ${op} via DAX — ${tag} ${C.dim}(${ms.toFixed(2)}ms)${C.reset}`,
  );
  return hit ? "HIT" : "MISS";
}

export function directRead(op: string, ms: number): void {
  console.log(
    `  ${C.gray}↳${C.reset} ${op} direct DynamoDB ${C.dim}(${ms.toFixed(2)}ms, no cache)${C.reset}`,
  );
}

export function ok(text: string): void {
  console.log(`  ${C.green}✓${C.reset} ${text}`);
}

export function warn(text: string): void {
  console.log(`  ${C.red}✕ ${text}${C.reset}`);
}

export function banner(lines: string[]): void {
  console.log(`\n${C.magenta}${C.bold}${lines.join("\n")}${C.reset}\n`);
}
