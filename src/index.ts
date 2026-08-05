#!/usr/bin/env node
/**
 * Servidor MCP para AimHarder.
 *
 * Herramientas:
 *   - list_classes      Lista las clases de un día (hora, nombre, coach, plazas, si estás apuntado).
 *   - book_class        Reserva una clase por hora o por classId.
 *   - cancel_class      Cancela tu reserva en una clase.
 *   - class_attendees   Lista quién está apuntado (requiere rol coach/admin en el box).
 *   - list_boxes        Muestra los boxes asociados a tu cuenta.
 *
 * Credenciales por variables de entorno:
 *   AIMHARDER_EMAIL, AIMHARDER_PASSWORD
 *
 * Trazas opcionales a un colector OTLP: ver src/tracing.ts.
 */

// Primero de todos a propósito: arranca OpenTelemetry (si está configurado) antes
// de que se importe node:http, que es lo que la instrumentación tiene que parchear.
import { instrumentMcpTools } from "./tracing.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AimHarderClient, type Booking } from "./aimharder.js";

const email = process.env.AIMHARDER_EMAIL;
const password = process.env.AIMHARDER_PASSWORD;

if (!email || !password) {
  console.error(
    "Faltan credenciales. Define AIMHARDER_EMAIL y AIMHARDER_PASSWORD en el entorno.",
  );
  process.exit(1);
}

const client = new AimHarderClient(email, password);

function formatBooking(b: Booking): string {
  const full = b.ocupation >= b.limit;
  const mine = b.bookState === 1 ? " ✅ RESERVADA" : "";
  const status = full ? " (LLENA)" : "";
  const coach = b.coachName ? ` · ${b.coachName}` : "";
  return `${b.time}  ${b.className}${coach}  [${b.ocupation}/${b.limit}]${status}${mine}  (id=${b.id})`;
}

/** Construye una instancia del server MCP con todas las herramientas registradas. */
function buildServer(): McpServer {
const server = instrumentMcpTools(
  new McpServer({
    name: "fitbot-mcp",
    version: "0.1.3",
  }),
);

const dateArg = z
  .string()
  .describe('Fecha en formato YYYY-MM-DD. Si se omite, se usa el día de hoy.')
  .optional();
const boxIdArg = z
  .number()
  .describe("id del box (boid). Solo necesario si tu cuenta pertenece a varios boxes.")
  .optional();

server.registerTool(
  "list_classes",
  {
    title: "Listar clases del día",
    description:
      "Lista las clases de un día concreto con su horario, coach, plazas ocupadas y si ya estás apuntado.",
    inputSchema: {
      date: dateArg,
      boxId: boxIdArg,
    },
  },
  async ({ date, boxId }) => {
    const classes = await client.listClasses(date, boxId);
    if (classes.length === 0) {
      return { content: [{ type: "text", text: "No hay clases para ese día." }] };
    }
    const text = classes.map(formatBooking).join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "book_class",
  {
    title: "Reservar clase",
    description:
      "Reserva una clase. Identifícala por hora de inicio (p.ej. \"18:15\") o por classId. " +
      "Si a esa hora hay varias clases, añade 'name' para desambiguar. " +
      "Con insist=true entras en lista de espera si está llena.",
    inputSchema: {
      date: dateArg,
      time: z.string().describe('Hora de inicio, p.ej. "18:15".').optional(),
      classId: z.number().describe("id de la clase (de list_classes).").optional(),
      name: z.string().describe("Filtro por nombre de clase, p.ej. \"CROSSFIT\".").optional(),
      insist: z.boolean().describe("Entrar en lista de espera si está llena.").optional(),
      boxId: boxIdArg,
    },
  },
  async ({ date, time, classId, name, insist, boxId }) => {
    const r = await client.book({ date, time, classId, name, insist, boxId });
    const header = r.ok ? "✅" : "❌";
    const details =
      `${header} ${formatBooking(r.booking)}\n` +
      `${r.message}` +
      (r.reservationId ? ` (reserva id=${r.reservationId})` : "");
    return { content: [{ type: "text", text: details }], isError: !r.ok };
  },
);

server.registerTool(
  "cancel_class",
  {
    title: "Cancelar reserva",
    description:
      "Cancela tu reserva en una clase. Identifícala por hora de inicio o por classId. " +
      "Usa late=true si cancelas fuera de plazo (puede penalizar según el box).",
    inputSchema: {
      date: dateArg,
      time: z.string().describe('Hora de inicio, p.ej. "18:15".').optional(),
      classId: z.number().describe("id de la clase (de list_classes).").optional(),
      name: z.string().describe("Filtro por nombre de clase.").optional(),
      late: z.boolean().describe("Cancelación fuera de plazo.").optional(),
      boxId: boxIdArg,
    },
  },
  async ({ date, time, classId, name, late, boxId }) => {
    const r = await client.cancel({ date, time, classId, name, late, boxId });
    const header = r.ok ? "✅" : "❌";
    return {
      content: [{ type: "text", text: `${header} ${formatBooking(r.booking)}\n${r.message}` }],
      isError: !r.ok,
    };
  },
);

server.registerTool(
  "class_attendees",
  {
    title: "Ver apuntados a una clase",
    description:
      "Lista quién se ha apuntado a una clase. NOTA: AimHarder solo expone esta lista a cuentas " +
      "con rol de coach/administrador en el box; para cuentas de cliente devuelve una nota informativa.",
    inputSchema: {
      date: dateArg,
      time: z.string().describe('Hora de inicio, p.ej. "18:15".').optional(),
      classId: z.number().describe("id de la clase (de list_classes).").optional(),
      name: z.string().describe("Filtro por nombre de clase.").optional(),
      boxId: boxIdArg,
    },
  },
  async ({ date, time, classId, name, boxId }) => {
    const r = await client.attendees({ date, time, classId, name, boxId });
    if (!r.available) {
      return { content: [{ type: "text", text: r.note ?? "Lista no disponible." }] };
    }
    if (r.attendees.length === 0) {
      return { content: [{ type: "text", text: "No hay nadie apuntado (o no se pudo leer la lista)." }] };
    }
    const text = `${r.attendees.length} apuntados:\n` + r.attendees.map((n, i) => `${i + 1}. ${n}`).join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "list_boxes",
  {
    title: "Listar mis boxes",
    description: "Muestra los boxes (gimnasios) asociados a tu cuenta y su id (boid).",
    inputSchema: {},
  },
  async () => {
    const roles = await client.listRoles();
    const text = roles
      .map((r) => `${r.gym}  (boid=${r.boid}, rol=${r.role}, ${r.centreUrl})`)
      .join("\n");
    return { content: [{ type: "text", text }] };
  },
);

  return server;
}

/** Arranca en modo stdio (Claude Desktop/Code lo lanzan como subproceso). */
async function runStdio() {
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  console.error("fitbot-mcp en marcha (stdio).");
}

/** Lee el cuerpo de una petición HTTP como JSON (o undefined si va vacío). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Arranca en modo HTTP (transporte Streamable HTTP del SDK) para clientes remotos
 * como n8n. Endpoint MCP en POST/GET/DELETE {path} (por defecto /mcp).
 *
 * Config por entorno:
 *   PORT          puerto (por defecto 8000)
 *   HOST          interfaz (por defecto 127.0.0.1; usa 0.0.0.0 en Docker)
 *   MCP_HTTP_PATH ruta del endpoint (por defecto /mcp)
 *   MCP_HTTP_TOKEN  si se define, exige cabecera Authorization: Bearer <token>
 */
async function runHttp() {
  const port = Number(process.env.PORT ?? 8000);
  const host = process.env.HOST ?? "127.0.0.1";
  const mcpPath = process.env.MCP_HTTP_PATH ?? "/mcp";
  const token = process.env.MCP_HTTP_TOKEN?.trim();

  // Sesiones activas: sessionId -> transporte.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const jsonError = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  };

  const httpServer = createHttpServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    if (path !== mcpPath) {
      jsonError(res, 404, "Not found");
      return;
    }
    if (token) {
      const auth = req.headers["authorization"];
      if (auth !== `Bearer ${token}`) {
        jsonError(res, 401, "Unauthorized");
        return;
      }
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (!transport) {
          if (!isInitializeRequest(body)) {
            jsonError(res, 400, "No hay sesión: falta la petición 'initialize'.");
            return;
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport!);
            },
          });
          transport.onclose = () => {
            if (transport!.sessionId) transports.delete(transport!.sessionId);
          };
          await buildServer().connect(transport);
        }
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (!transport) {
          jsonError(res, 400, "Sesión no válida o ausente (cabecera mcp-session-id).");
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      jsonError(res, 405, "Método no permitido");
    } catch (err) {
      console.error("Error atendiendo petición MCP:", err);
      if (!res.headersSent) jsonError(res, 500, "Error interno");
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  console.error(
    `fitbot-mcp en marcha (HTTP) en http://${host}:${port}${mcpPath}` +
      (token ? " [auth: Bearer token requerido]" : ""),
  );
}

async function main() {
  const useHttp =
    process.argv.includes("--http") ||
    (process.env.MCP_TRANSPORT ?? "").toLowerCase() === "http";
  if (useHttp) await runHttp();
  else await runStdio();
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
