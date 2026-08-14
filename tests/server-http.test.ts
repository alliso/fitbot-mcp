/**
 * Transporte HTTP: se levanta un servidor real en un puerto libre y se le habla
 * con el cliente MCP de verdad. Los casos raros (405, error interno) se prueban
 * llamando al handler directamente, que es más fiable que provocarlos por red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpServer, readJsonBody, runHttp, type HttpOptions } from "../src/server.js";
import type { Booking } from "../src/aimharder.js";

const bookings: Booking[] = [
  {
    id: 7,
    time: "18:15 - 19:15",
    timeid: "1815_60",
    className: "CROSSFIT",
    coachName: "Coach K",
    ocupation: 5,
    limit: 12,
    bookState: null,
    idres: null,
    waitlist: 0,
  },
];

const aim = {
  listClasses: vi.fn(async () => bookings),
  listRoles: vi.fn(async () => [{ boid: 100, centreUrl: "mybox.aimharder.com", gym: "Mi Box", role: "client" }]),
  book: vi.fn(),
  cancel: vi.fn(),
  attendees: vi.fn(),
} as any;

const opened: Array<Server | { close: () => Promise<void> }> = [];

/** Levanta el server en un puerto libre y devuelve su URL base. */
async function serve(over: Partial<HttpOptions> = {}) {
  const server = await runHttp(aim, {
    port: 0,
    host: "127.0.0.1",
    mcpPath: "/mcp",
    ...over,
  });
  opened.push(server);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, mcpPath: over.mcpPath ?? "/mcp" };
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(async () => {
  for (const s of opened.splice(0)) {
    await new Promise<void>((resolve) => {
      if ("closeAllConnections" in s) {
        (s as Server).closeAllConnections();
        (s as Server).close(() => resolve());
      } else {
        void (s as any).close().then(resolve, resolve);
      }
    });
  }
});

describe("rutas básicas", () => {
  it("/health responde 200 ok sin autenticación", async () => {
    const { base } = await serve({ token: "secreto" });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("devuelve 404 JSON-RPC en rutas desconocidas", async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/otra`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Not found" },
      id: null,
    });
  });

  it("respeta MCP_HTTP_PATH", async () => {
    const { base } = await serve({ mcpPath: "/fitbot" });
    expect((await fetch(`${base}/mcp`)).status).toBe(404);
    // Sin sesión, pero la ruta existe.
    expect((await fetch(`${base}/fitbot`)).status).toBe(400);
  });

  it("ignora la query string al enrutar", async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/health?verbose=1`)).status).toBe(200);
  });
});

describe("autenticación", () => {
  it("sin token configurado no exige cabecera", async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/mcp`)).status).toBe(400); // llega al handler MCP
  });

  it("rechaza sin cabecera Authorization", async () => {
    const { base } = await serve({ token: "secreto" });
    const res = await fetch(`${base}/mcp`);
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe("Unauthorized");
  });

  it("rechaza un token que no coincide", async () => {
    const { base } = await serve({ token: "secreto" });
    const res = await fetch(`${base}/mcp`, { headers: { Authorization: "Bearer otro" } });
    expect(res.status).toBe(401);
  });

  it("acepta el token correcto", async () => {
    const { base } = await serve({ token: "secreto" });
    const res = await fetch(`${base}/mcp`, { headers: { Authorization: "Bearer secreto" } });
    expect(res.status).toBe(400); // pasa el filtro, falla por falta de sesión
  });
});

describe("gestión de sesión", () => {
  it("rechaza un POST que no sea 'initialize' cuando no hay sesión", async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/falta la petición 'initialize'/);
  });

  it("rechaza un POST con cuerpo vacío o no-JSON", async () => {
    const { base } = await serve();
    for (const body of ["", "no soy json"]) {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
    }
  });

  it.each(["GET", "DELETE"])("rechaza %s sin mcp-session-id", async (method) => {
    const { base } = await serve();
    const res = await fetch(`${base}/mcp`, { method });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Sesión no válida o ausente/);
  });

  it("rechaza GET con un mcp-session-id desconocido", async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/mcp`, { headers: { "mcp-session-id": "no-existe" } });
    expect(res.status).toBe(400);
  });
});

describe("sesión MCP completa sobre HTTP", () => {
  it("initialize, tools/list y tools/call reutilizando la sesión", async () => {
    const { base, mcpPath } = await serve();
    const transport = new StreamableHTTPClientTransport(new URL(`${base}${mcpPath}`));
    const client = new Client({ name: "test-http", version: "0" });
    opened.push({ close: () => client.close() });

    await client.connect(transport);
    expect(transport.sessionId).toBeTruthy();

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(5);

    const res: any = await client.callTool({ name: "list_classes", arguments: { date: "2026-07-24" } });
    expect(res.content[0].text).toContain("CROSSFIT");
    expect(aim.listClasses).toHaveBeenCalledWith("2026-07-24", undefined);

    // Segunda llamada: misma sesión, no se crea otro transporte.
    await client.listTools();
    expect(transport.sessionId).toBeTruthy();

    // DELETE cierra la sesión en el servidor.
    await transport.terminateSession();
  });

  it("mantiene sesiones independientes para dos clientes", async () => {
    const { base, mcpPath } = await serve();
    const mk = async () => {
      const t = new StreamableHTTPClientTransport(new URL(`${base}${mcpPath}`));
      const c = new Client({ name: "t", version: "0" });
      opened.push({ close: () => c.close() });
      await c.connect(t);
      return t.sessionId;
    };

    const [a, b] = await Promise.all([mk(), mk()]);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("propaga el token en la sesión autenticada", async () => {
    const { base, mcpPath } = await serve({ token: "secreto" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}${mcpPath}`), {
      requestInit: { headers: { Authorization: "Bearer secreto" } },
    });
    const client = new Client({ name: "test-http", version: "0" });
    opened.push({ close: () => client.close() });

    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(5);
  });
});

/** Acceso directo al handler para los caminos que cuesta provocar por red. */
function handlerOf(opts: Partial<HttpOptions> = {}) {
  const server = createMcpHttpServer(aim, { port: 0, host: "127.0.0.1", mcpPath: "/mcp", ...opts });
  return server.listeners("request")[0] as (req: any, res: any) => Promise<void>;
}

function fakeRes() {
  return {
    headersSent: false,
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk?: string) {
      if (chunk) this.body = chunk;
    },
  };
}

describe("casos límite del handler", () => {
  it("responde 405 a métodos no soportados", async () => {
    const res = fakeRes();
    await handlerOf()({ url: "/mcp", method: "PUT", headers: {} }, res);

    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body).error.message).toBe("Método no permitido");
  });

  it("responde 500 si algo revienta leyendo la petición", async () => {
    const res = fakeRes();
    const req = {
      url: "/mcp",
      method: "POST",
      headers: {},
      async *[Symbol.asyncIterator]() {
        throw new Error("socket roto");
      },
    };

    await handlerOf()(req, res);
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.message).toBe("Error interno");
  });

  it("no intenta responder si ya se enviaron cabeceras", async () => {
    const res = fakeRes();
    res.headersSent = true;
    const req = {
      url: "/mcp",
      method: "POST",
      headers: {},
      async *[Symbol.asyncIterator]() {
        throw new Error("socket roto");
      },
    };

    await handlerOf()(req, res);
    expect(res.statusCode).toBe(0);
    expect(res.body).toBe("");
  });

  it("trata una url ausente como ruta vacía (404)", async () => {
    const res = fakeRes();
    await handlerOf()({ method: "GET", headers: {} }, res);
    expect(res.statusCode).toBe(404);
  });
});

describe("readJsonBody", () => {
  const req = (chunks: string[]) => ({
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield Buffer.from(c);
    },
  });

  it("junta los chunks y parsea JSON", async () => {
    await expect(readJsonBody(req(['{"a"', ":1}"]) as any)).resolves.toEqual({ a: 1 });
  });

  it("devuelve undefined si no hay cuerpo", async () => {
    await expect(readJsonBody(req([]) as any)).resolves.toBeUndefined();
  });

  it("devuelve undefined si el cuerpo no es JSON válido", async () => {
    await expect(readJsonBody(req(["no json"]) as any)).resolves.toBeUndefined();
  });

  it("respeta el UTF-8 partido entre chunks", async () => {
    const buf = Buffer.from(JSON.stringify({ gym: "Móstoles" }));
    const parts = [buf.subarray(0, 10), buf.subarray(10)];
    const split = {
      async *[Symbol.asyncIterator]() {
        for (const p of parts) yield p;
      },
    };
    await expect(readJsonBody(split as any)).resolves.toEqual({ gym: "Móstoles" });
  });
});
