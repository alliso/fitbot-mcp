import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const activeSpan = { spanContext: vi.fn() };

vi.mock("@opentelemetry/api", () => ({
  trace: { getActiveSpan: () => activeSpan },
  isSpanContextValid: (ctx: any) => Boolean(ctx?.valid),
}));

/**
 * El nivel se calcula al importar el módulo, así que cada caso reimporta el
 * logger con su propio LOG_LEVEL.
 */
async function freshLogger(level?: string) {
  vi.resetModules();
  if (level === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = level;
  const mod = await import("../src/logger.js");
  return mod.logger;
}

let written: string[];

beforeEach(() => {
  written = [];
  activeSpan.spanContext.mockReturnValue(undefined);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  delete process.env.LOG_LEVEL;
});

/** Última línea escrita, ya parseada. */
function lastEntry() {
  return JSON.parse(written[written.length - 1]);
}

describe("formato de salida", () => {
  it("escribe una línea JSON por evento, terminada en \\n, en stderr", async () => {
    const logger = await freshLogger();
    logger.info("hola");

    expect(written).toHaveLength(1);
    expect(written[0].endsWith("\n")).toBe(true);
    expect(lastEntry()).toEqual({
      ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      level: "info",
      msg: "hola",
    });
  });

  it("nunca escribe en stdout (rompería el protocolo MCP en modo stdio)", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const logger = await freshLogger("debug");
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(stdout).not.toHaveBeenCalled();
    expect(written).toHaveLength(4);
  });

  it("añade los campos extra y descarta los undefined", async () => {
    const logger = await freshLogger();
    logger.info("tool ok", { tool: "book_class", args: undefined, duration_ms: 12, nulo: null });

    const entry = lastEntry();
    expect(entry).toMatchObject({ tool: "book_class", duration_ms: 12, nulo: null });
    expect(entry).not.toHaveProperty("args");
  });

  it("aplana los Error, que si no se serializan como {}", async () => {
    const logger = await freshLogger();
    const err = new TypeError("boom");
    logger.error("fatal", { err });

    expect(lastEntry().err).toEqual({
      name: "TypeError",
      message: "boom",
      stack: expect.stringContaining("boom"),
    });
  });

  it("degrada a una línea mínima si algún campo no es serializable", async () => {
    const logger = await freshLogger();
    const circular: any = { name: "loop" };
    circular.self = circular;
    logger.warn("raro", { circular });

    expect(lastEntry()).toEqual({
      ts: expect.any(String),
      level: "warn",
      msg: "raro",
      log_error: "campos no serializables",
    });
  });
});

describe("niveles", () => {
  it("por defecto es info: descarta debug", async () => {
    const logger = await freshLogger();
    logger.debug("no");
    logger.info("sí");
    expect(written).toHaveLength(1);
    expect(lastEntry().msg).toBe("sí");
  });

  it("con LOG_LEVEL=warn solo pasan warn y error", async () => {
    const logger = await freshLogger("warn");
    logger.debug("no");
    logger.info("no");
    logger.warn("sí");
    logger.error("sí");
    expect(written).toHaveLength(2);
  });

  it("con LOG_LEVEL=error solo pasa error", async () => {
    const logger = await freshLogger("error");
    logger.warn("no");
    logger.error("sí");
    expect(written).toHaveLength(1);
    expect(lastEntry().level).toBe("error");
  });

  it("con LOG_LEVEL=debug pasa todo", async () => {
    const logger = await freshLogger("  DEBUG  ");
    logger.debug("sí");
    expect(written).toHaveLength(1);
  });

  it.each(["silent", "off", "none", "SILENT"])("con LOG_LEVEL=%s no escribe nada", async (level) => {
    const logger = await freshLogger(level);
    logger.debug("no");
    logger.info("no");
    logger.warn("no");
    logger.error("no");
    expect(written).toHaveLength(0);
  });

  it("cae a info si el nivel no se reconoce", async () => {
    const logger = await freshLogger("verboso");
    logger.debug("no");
    logger.info("sí");
    expect(written).toHaveLength(1);
  });
});

describe("correlación con trazas", () => {
  it("añade trace_id/span_id si hay un span activo válido", async () => {
    activeSpan.spanContext.mockReturnValue({ traceId: "t-1", spanId: "s-1", valid: true });
    const logger = await freshLogger();
    logger.info("con traza");

    expect(lastEntry()).toMatchObject({ trace_id: "t-1", span_id: "s-1" });
  });

  it("no añade nada si el contexto del span no es válido", async () => {
    activeSpan.spanContext.mockReturnValue({ traceId: "0".repeat(32), spanId: "0", valid: false });
    const logger = await freshLogger();
    logger.info("sin traza");

    const entry = lastEntry();
    expect(entry).not.toHaveProperty("trace_id");
    expect(entry).not.toHaveProperty("span_id");
  });

  it("no añade nada si no hay span activo", async () => {
    activeSpan.spanContext.mockReturnValue(undefined);
    const logger = await freshLogger();
    logger.info("sin span");
    expect(lastEntry()).not.toHaveProperty("trace_id");
  });
});
