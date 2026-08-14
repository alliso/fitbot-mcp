/**
 * Modo stdio y selección de transporte en main(). El StdioServerTransport va
 * mockeado: el de verdad se adueña de process.stdin/stdout y dejaría el runner
 * de tests sin consola.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** Transporte con lo mínimo que exige el Protocol del SDK para conectar. */
const StdioServerTransport = vi.fn(function (this: any) {
  this.start = vi.fn(async () => {});
  this.send = vi.fn(async () => {});
  this.close = vi.fn(async () => {});
});
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport }));

const aim = {
  listClasses: vi.fn(async () => []),
  listRoles: vi.fn(async () => []),
  book: vi.fn(),
  cancel: vi.fn(),
  attendees: vi.fn(),
} as any;

let written: any[];
let mod: typeof import("../src/server.js");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.LOG_LEVEL = "debug";

  written = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    written.push(JSON.parse(String(chunk)));
    return true;
  });

  mod = await import("../src/server.js");
});

afterEach(() => {
  delete process.env.LOG_LEVEL;
  delete process.env.MCP_TRANSPORT;
  delete process.env.PORT;
  delete process.env.HOST;
});

const entry = (msg: string) => written.find((w) => w.msg === msg);

describe("runStdio", () => {
  it("conecta el server al transporte stdio y lo anuncia en el log", async () => {
    await mod.runStdio(aim);

    expect(StdioServerTransport).toHaveBeenCalledOnce();
    expect(entry("server started")).toMatchObject({
      transport: "stdio",
      version: mod.VERSION,
    });
  });
});

describe("main", () => {
  it("arranca en stdio por defecto", async () => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "index.js"]);

    await mod.main(aim);

    expect(StdioServerTransport).toHaveBeenCalledOnce();
    expect(entry("server started")).toMatchObject({ transport: "stdio" });
  });

  it("arranca en HTTP con --http", async () => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "index.js", "--http"]);
    process.env.PORT = "0"; // puerto libre: no colisiona con nada
    process.env.HOST = "127.0.0.1";

    const server = (await mod.main(aim))!;
    try {
      expect(StdioServerTransport).not.toHaveBeenCalled();
      expect(entry("server started")).toMatchObject({
        transport: "http",
        host: "127.0.0.1",
        path: "/mcp",
        auth_required: false,
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("arranca en HTTP con MCP_TRANSPORT=http", async () => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "index.js"]);
    process.env.MCP_TRANSPORT = "http";
    process.env.PORT = "0";

    const server = (await mod.main(aim))!;
    try {
      expect(entry("server started")).toMatchObject({ transport: "http" });
      expect(StdioServerTransport).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("devuelve undefined en modo stdio (no hay server que cerrar)", async () => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "index.js"]);
    await expect(mod.main(aim)).resolves.toBeUndefined();
  });

  it("anuncia auth_required cuando hay token", async () => {
    const server = await mod.runHttp(aim, {
      port: 0,
      host: "127.0.0.1",
      mcpPath: "/fitbot",
      token: "secreto",
    });
    try {
      expect(entry("server started")).toMatchObject({ auth_required: true, path: "/fitbot" });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
