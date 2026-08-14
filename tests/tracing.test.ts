/**
 * Tracing *desactivado* (sin OTEL_EXPORTER_OTLP_ENDPOINT), que es el modo por
 * defecto y el único que se usa en stdio. Aquí lo que importa es que
 * instrumentMcpTools siga dejando logs aunque no haya spans.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let written: any[];
let instrumentMcpTools: typeof import("../src/tracing.js").instrumentMcpTools;
let tracingEnabled: boolean;

beforeEach(async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  process.env.LOG_LEVEL = "debug";
  vi.resetModules();

  written = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    written.push(JSON.parse(String(chunk)));
    return true;
  });

  const mod = await import("../src/tracing.js");
  instrumentMcpTools = mod.instrumentMcpTools;
  tracingEnabled = mod.tracingEnabled;
});

afterEach(() => {
  delete process.env.LOG_LEVEL;
});

/** Server MCP de mentira: solo nos interesa qué callback acaba registrado. */
function fakeServer() {
  const registered = new Map<string, (...a: any[]) => any>();
  const server = {
    registerTool: vi.fn((name: string, _cfg: unknown, handler: (...a: any[]) => any) => {
      registered.set(name, handler);
      return `registrado:${name}`;
    }),
  };
  return { server, registered };
}

const entry = (msg: string) => written.find((w) => w.msg === msg);

describe("tracing desactivado", () => {
  it("no se activa sin OTEL_EXPORTER_OTLP_ENDPOINT", () => {
    expect(tracingEnabled).toBe(false);
  });
});

describe("instrumentMcpTools", () => {
  it("devuelve el mismo server y respeta el valor de retorno de registerTool", () => {
    const { server } = fakeServer();
    const out = instrumentMcpTools(server as any);
    expect(out).toBe(server);
    expect((server as any).registerTool("list_boxes", {}, async () => ({}))).toBe(
      "registrado:list_boxes",
    );
  });

  it("registra un callback distinto del original pero con la misma config", () => {
    const { server, registered } = fakeServer();
    const original = async () => ({ ok: true });
    // instrumentMcpTools sustituye el método: hay que guardar el spy original.
    const spy = server.registerTool;
    instrumentMcpTools(server as any);
    (server as any).registerTool("list_classes", { title: "T" }, original);

    expect(spy).toHaveBeenCalledWith("list_classes", { title: "T" }, expect.any(Function));
    expect(registered.get("list_classes")).not.toBe(original);
  });

  it("pasa todos los argumentos al handler y devuelve su resultado", async () => {
    const { server, registered } = fakeServer();
    const handler = vi.fn(async () => ({ content: [] }));
    instrumentMcpTools(server as any);
    (server as any).registerTool("book_class", {}, handler);

    const result = await registered.get("book_class")!({ time: "18:15" }, { extra: true });
    expect(handler).toHaveBeenCalledWith({ time: "18:15" }, { extra: true });
    expect(result).toEqual({ content: [] });
  });

  it("loguea inicio y fin correcto con la duración", async () => {
    const { server, registered } = fakeServer();
    instrumentMcpTools(server as any);
    (server as any).registerTool("list_classes", {}, async () => ({}));

    await registered.get("list_classes")!({ date: "2026-07-24" });

    expect(entry("tool start")).toMatchObject({
      level: "debug",
      tool: "list_classes",
      args: { date: "2026-07-24" },
    });
    expect(entry("tool ok")).toMatchObject({ level: "info", tool: "list_classes" });
    expect(entry("tool ok").duration_ms).toBeTypeOf("number");
  });

  it("loguea como warn cuando la herramienta devuelve isError", async () => {
    const { server, registered } = fakeServer();
    instrumentMcpTools(server as any);
    (server as any).registerTool("book_class", {}, async () => ({ isError: true }));

    const r = await registered.get("book_class")!({ time: "18:15" });
    expect(r).toEqual({ isError: true });
    expect(entry("tool error")).toMatchObject({ level: "warn", tool: "book_class" });
    expect(entry("tool ok")).toBeUndefined();
  });

  it("loguea y repropaga si el handler lanza", async () => {
    const { server, registered } = fakeServer();
    instrumentMcpTools(server as any);
    (server as any).registerTool("cancel_class", {}, async () => {
      throw new Error("AimHarder caído");
    });

    await expect(registered.get("cancel_class")!({ classId: 1 })).rejects.toThrow("AimHarder caído");
    expect(entry("tool failed")).toMatchObject({
      level: "error",
      tool: "cancel_class",
      err: { message: "AimHarder caído" },
    });
  });

  it("tolera un resultado nulo (no todas las herramientas devuelven objeto)", async () => {
    const { server, registered } = fakeServer();
    instrumentMcpTools(server as any);
    (server as any).registerTool("raro", {}, async () => undefined);

    await expect(registered.get("raro")!({})).resolves.toBeUndefined();
    expect(entry("tool ok")).toBeDefined();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["un objeto vacío", {}],
    ["un objeto con todo undefined", { date: undefined, boxId: undefined }],
    ["un array", ["18:15"]],
    ["un string", "18:15"],
  ])("omite 'args' en el log cuando recibe %s", async (_name, input) => {
    const { server, registered } = fakeServer();
    instrumentMcpTools(server as any);
    (server as any).registerTool("list_boxes", {}, async () => ({}));

    await registered.get("list_boxes")!(input);
    expect(entry("tool start")).not.toHaveProperty("args");
  });

  it("filtra solo los argumentos undefined y conserva el resto", async () => {
    const { server, registered } = fakeServer();
    instrumentMcpTools(server as any);
    (server as any).registerTool("book_class", {}, async () => ({}));

    await registered.get("book_class")!({ date: undefined, time: "18:15", insist: false, boxId: 100 });
    expect(entry("tool start").args).toEqual({ time: "18:15", insist: false, boxId: 100 });
  });
});
