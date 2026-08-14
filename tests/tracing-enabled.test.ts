/**
 * Tracing *activado* (con OTEL_EXPORTER_OTLP_ENDPOINT). Todo el SDK de OTel va
 * mockeado: aquí solo se comprueba el cableado (loader ESM, instrumentaciones,
 * apagado limpio y atributos/estado de los spans de herramienta).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const register = vi.fn();
vi.mock("node:module", () => ({ register }));

const sdkStart = vi.fn();
const sdkShutdown = vi.fn(async () => {});
const NodeSDK = vi.fn(function (this: any) {
  this.start = sdkStart;
  this.shutdown = sdkShutdown;
});
vi.mock("@opentelemetry/sdk-node", () => ({ NodeSDK }));

const OTLPTraceExporter = vi.fn();
vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({ OTLPTraceExporter }));

const HttpInstrumentation = vi.fn(function (this: any, cfg: any) {
  this.cfg = cfg;
});
vi.mock("@opentelemetry/instrumentation-http", () => ({ HttpInstrumentation }));

const UndiciInstrumentation = vi.fn();
vi.mock("@opentelemetry/instrumentation-undici", () => ({ UndiciInstrumentation }));

/** Span de mentira que registra lo que le hacen. */
function makeSpan() {
  return {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    end: vi.fn(),
    spanContext: () => ({ traceId: "t", spanId: "s", valid: true }),
  };
}

let currentSpan: ReturnType<typeof makeSpan>;
const startActiveSpan = vi.fn(async (_name: string, fn: (s: any) => any) => fn(currentSpan));

vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: vi.fn(() => ({ startActiveSpan })),
    getActiveSpan: () => currentSpan,
  },
  isSpanContextValid: () => true,
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
}));

let tracing: typeof import("../src/tracing.js");
let written: any[];
let signalHandlers: Record<string, (...a: any[]) => void>;

beforeEach(async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "  http://tempo:4318  ";
  process.env.LOG_LEVEL = "debug";
  vi.resetModules();
  vi.clearAllMocks();

  currentSpan = makeSpan();
  written = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    written.push(JSON.parse(String(chunk)));
    return true;
  });

  signalHandlers = {};
  vi.spyOn(process, "once").mockImplementation(((sig: string, fn: any) => {
    signalHandlers[sig] = fn;
    return process;
  }) as any);

  tracing = await import("../src/tracing.js");
});

afterEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.LOG_LEVEL;
});

describe("arranque del SDK", () => {
  it("se activa y arranca el NodeSDK", () => {
    expect(tracing.tracingEnabled).toBe(true);
    expect(NodeSDK).toHaveBeenCalledOnce();
    expect(sdkStart).toHaveBeenCalledOnce();
    expect(OTLPTraceExporter).toHaveBeenCalledOnce();
  });

  it("registra el loader ESM antes de instrumentar (si no, node:http no se parchea)", () => {
    expect(register).toHaveBeenCalledWith("@opentelemetry/instrumentation/hook.mjs", expect.any(String));
  });

  it("instrumenta http y undici", () => {
    expect(HttpInstrumentation).toHaveBeenCalledOnce();
    expect(UndiciInstrumentation).toHaveBeenCalledOnce();
    const { instrumentations } = NodeSDK.mock.calls[0][0] as any;
    expect(instrumentations).toHaveLength(2);
  });

  it("ignora /health para que las probes no llenen Tempo", () => {
    const cfg = HttpInstrumentation.mock.calls[0][0] as any;
    expect(cfg.ignoreIncomingRequestHook({ url: "/health" })).toBe(true);
    expect(cfg.ignoreIncomingRequestHook({ url: "/health?verbose=1" })).toBe(true);
    expect(cfg.ignoreIncomingRequestHook({ url: "/mcp" })).toBe(false);
    expect(cfg.ignoreIncomingRequestHook({})).toBe(false);
  });

  it.each(["SIGTERM", "SIGINT"])("vacía el buffer de spans al recibir %s", async (sig) => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as any);

    signalHandlers[sig]!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(sdkShutdown).toHaveBeenCalledOnce();
    expect(written.find((w) => w.msg === "server stopping")).toMatchObject({ reason: "signal" });
  });

  it("no arranca nada si el endpoint está vacío", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "   ";
    vi.resetModules();
    vi.clearAllMocks();

    const mod = await import("../src/tracing.js");
    expect(mod.tracingEnabled).toBe(false);
    expect(NodeSDK).not.toHaveBeenCalled();
  });
});

function fakeServer() {
  const registered = new Map<string, (...a: any[]) => any>();
  const server = {
    registerTool: vi.fn((name: string, _cfg: unknown, handler: (...a: any[]) => any) => {
      registered.set(name, handler);
    }),
  };
  tracing.instrumentMcpTools(server as any);
  return { server, registered };
}

describe("spans de herramienta", () => {
  it("abre un span por llamada, con nombre y atributo", async () => {
    const { server, registered } = fakeServer();
    (server as any).registerTool("list_classes", {}, async () => ({}));

    await registered.get("list_classes")!({ date: "2026-07-24" });

    expect(startActiveSpan).toHaveBeenCalledWith("mcp.tool list_classes", expect.any(Function));
    expect(currentSpan.setAttribute).toHaveBeenCalledWith("mcp.tool.name", "list_classes");
    expect(currentSpan.end).toHaveBeenCalledOnce();
    expect(currentSpan.setStatus).not.toHaveBeenCalled();
  });

  it("marca el span como ERROR cuando la herramienta devuelve isError", async () => {
    const { server, registered } = fakeServer();
    (server as any).registerTool("book_class", {}, async () => ({ isError: true }));

    await registered.get("book_class")!({});

    expect(currentSpan.setStatus).toHaveBeenCalledWith({ code: 2 });
    expect(currentSpan.setAttribute).toHaveBeenCalledWith("mcp.tool.is_error", true);
    expect(currentSpan.end).toHaveBeenCalledOnce();
  });

  it("graba la excepción y cierra el span si el handler lanza", async () => {
    const boom = new Error("AimHarder caído");
    const { server, registered } = fakeServer();
    (server as any).registerTool("cancel_class", {}, async () => {
      throw boom;
    });

    await expect(registered.get("cancel_class")!({})).rejects.toThrow(boom);
    expect(currentSpan.recordException).toHaveBeenCalledWith(boom);
    expect(currentSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: "AimHarder caído" });
    expect(currentSpan.end).toHaveBeenCalledOnce();
  });

  it("usa String() en el mensaje si lo lanzado no es un Error", async () => {
    const { server, registered } = fakeServer();
    (server as any).registerTool("raro", {}, async () => {
      throw "solo un string";
    });

    await expect(registered.get("raro")!({})).rejects.toBe("solo un string");
    expect(currentSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: "solo un string" });
  });

  it("correlaciona el log con el span activo", async () => {
    const { server, registered } = fakeServer();
    (server as any).registerTool("list_boxes", {}, async () => ({}));

    await registered.get("list_boxes")!({});
    expect(written.find((w) => w.msg === "tool ok")).toMatchObject({ trace_id: "t", span_id: "s" });
  });
});
