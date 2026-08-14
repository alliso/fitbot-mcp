/**
 * Logger estructurado: una línea JSON por evento, siempre a **stderr**.
 *
 * stdout no se puede tocar: en modo stdio es el canal por el que viaja el
 * protocolo MCP y cualquier línea suelta rompe al cliente. En modo HTTP da
 * igual, y así el comportamiento es el mismo en los dos transportes.
 *
 * Si el tracing está activo, cada línea lleva `trace_id`/`span_id` del span en
 * curso, que es lo que permite saltar de un log en Loki a su traza en Tempo.
 *
 * Config por entorno:
 *   LOG_LEVEL  debug | info | warn | error | silent   (por defecto info)
 */

import { trace, isSpanContextValid } from "@opentelemetry/api";

export type LogLevel = "debug" | "info" | "warn" | "error";

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SILENT = Number.POSITIVE_INFINITY;

function configuredThreshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").trim().toLowerCase();
  if (raw === "silent" || raw === "off" || raw === "none") return SILENT;
  return SEVERITY[raw as LogLevel] ?? SEVERITY.info;
}

const threshold = configuredThreshold();

export type LogFields = Record<string, unknown>;

/** Los Error no sobreviven a JSON.stringify (sale `{}`): se aplanan a mano. */
function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { message: value.message, name: value.name, stack: value.stack };
  }
  return value;
}

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  if (SEVERITY[level] < threshold) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };

  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) continue; // los argumentos opcionales vienen vacíos casi siempre
    entry[key] = serialize(value);
  }

  const ctx = trace.getActiveSpan()?.spanContext();
  if (ctx && isSpanContextValid(ctx)) {
    entry.trace_id = ctx.traceId;
    entry.span_id = ctx.spanId;
  }

  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    // Referencias circulares en algún campo: mejor una línea pobre que perder el log.
    line = JSON.stringify({ ts: entry.ts, level, msg, log_error: "campos no serializables" });
  }
  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => write("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => write("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => write("error", msg, fields),
};
