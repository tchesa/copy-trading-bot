type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = "info";

export function setLogLevel(level: Level): void {
  threshold = level;
}

function emit(level: Level, scope: string, msg: string, data?: unknown): void {
  if (order[level] < order[threshold]) return;
  const ts = new Date().toISOString();
  const extra = data === undefined ? "" : " " + safeJson(data);
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${extra}`;
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function safeJson(v: unknown): string {
  try {
    if (v instanceof Error) return JSON.stringify({ error: v.message, name: v.name });
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function logger(scope: string) {
  return {
    debug: (msg: string, data?: unknown) => emit("debug", scope, msg, data),
    info: (msg: string, data?: unknown) => emit("info", scope, msg, data),
    warn: (msg: string, data?: unknown) => emit("warn", scope, msg, data),
    error: (msg: string, data?: unknown) => emit("error", scope, msg, data),
  };
}
export type Logger = ReturnType<typeof logger>;
