/**
 * Construcción del servidor MCP y sus dos transportes (stdio y HTTP).
 *
 * Vive separado de index.ts para que se pueda importar sin arrancar nada:
 * index.ts es solo el bootstrap (lee credenciales y llama a main()).
 */

import { createServer as createNodeHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { instrumentMcpTools } from "./tracing.js";
import type { AimHarderClient, Booking } from "./aimharder.js";
import { logger } from "./logger.js";

export const VERSION = "0.1.5";

export function formatBooking(b: Booking): string {
  const full = b.ocupation >= b.limit;
  const mine = b.bookState === 1 ? " ✅ RESERVADA" : "";
  const status = full ? " (LLENA)" : "";
  const coach = b.coachName ? ` · ${b.coachName}` : "";
  return `${b.time}  ${b.className}${coach}  [${b.ocupation}/${b.limit}]${status}${mine}  (id=${b.id})`;
}

/** Construye una instancia del server MCP con todas las herramientas registradas. */
export function buildServer(client: AimHarderClient): McpServer {
  const server = instrumentMcpTools(
    new McpServer({
      name: "fitbot-mcp",
      version: VERSION,
    }),
  );

  // Stryker disable StringLiteral : los textos de ayuda son prosa para el LLM;
  // afirmar sobre ellos en un test solo ata las manos al reescribirlos.
  const dateArg = z
    .string()
    .describe("Fecha en formato YYYY-MM-DD. Si se omite, se usa el día de hoy.")
    .optional();
  const boxIdArg = z
    .number()
    .describe("id del box (boid). Solo necesario si tu cuenta pertenece a varios boxes.")
    .optional();
  // Stryker restore StringLiteral

  server.registerTool(
    "list_classes",
    {
      // Stryker disable StringLiteral
      title: "Listar clases del día",
      description:
        "Lista las clases de un día concreto con su horario, coach, plazas ocupadas y si ya estás apuntado.",
      // Stryker restore StringLiteral
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
      // Stryker disable StringLiteral
      title: "Reservar clase",
      description:
        'Reserva una clase. Identifícala por hora de inicio (p.ej. "18:15") o por classId. ' +
        "Si a esa hora hay varias clases, añade 'name' para desambiguar. " +
        "Con insist=true entras en lista de espera si está llena.",
      inputSchema: {
        date: dateArg,
        time: z.string().describe('Hora de inicio, p.ej. "18:15".').optional(),
        classId: z.number().describe("id de la clase (de list_classes).").optional(),
        name: z.string().describe('Filtro por nombre de clase, p.ej. "CROSSFIT".').optional(),
        insist: z.boolean().describe("Entrar en lista de espera si está llena.").optional(),
        boxId: boxIdArg,
      },
      // Stryker restore StringLiteral
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
      // Stryker disable StringLiteral
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
      // Stryker restore StringLiteral
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
      // Stryker disable StringLiteral
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
      // Stryker restore StringLiteral
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
      // Stryker disable StringLiteral
      title: "Listar mis boxes",
      description: "Muestra los boxes (gimnasios) asociados a tu cuenta y su id (boid).",
      // Stryker restore StringLiteral
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
export async function runStdio(client: AimHarderClient): Promise<void> {
  const transport = new StdioServerTransport();
  await buildServer(client).connect(transport);
  logger.info("server started", { transport: "stdio", version: VERSION });
}

/** Lee el cuerpo de una petición HTTP como JSON (o undefined si va vacío). */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

export interface HttpOptions {
  port: number;
  host: string;
  mcpPath: string;
  token?: string;
}

/**
 * Config del modo HTTP por entorno:
 *   PORT            puerto (por defecto 8000)
 *   HOST            interfaz (por defecto 127.0.0.1; usa 0.0.0.0 en Docker)
 *   MCP_HTTP_PATH   ruta del endpoint (por defecto /mcp)
 *   MCP_HTTP_TOKEN  si se define, exige cabecera Authorization: Bearer <token>
 */
export function httpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  return {
    port: Number(env.PORT ?? 8000),
    host: env.HOST ?? "127.0.0.1",
    mcpPath: env.MCP_HTTP_PATH ?? "/mcp",
    token: env.MCP_HTTP_TOKEN?.trim() || undefined,
  };
}

/**
 * Crea el servidor HTTP (transporte Streamable HTTP del SDK) para clientes
 * remotos como n8n. Endpoint MCP en POST/GET/DELETE {mcpPath}, más /health.
 */
export function createMcpHttpServer(client: AimHarderClient, opts: HttpOptions): Server {
  const { mcpPath, token } = opts;

  // Sesiones activas: sessionId -> transporte.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const jsonError = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  };

  return createNodeHttpServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    if (path !== mcpPath) {
      // Stryker disable next-line all : línea de log, no comportamiento observable
      logger.debug("http 404", { method: req.method, path });
      jsonError(res, 404, "Not found");
      return;
    }
    if (token) {
      const auth = req.headers["authorization"];
      if (auth !== `Bearer ${token}`) {
        // Stryker disable all : línea de log, no comportamiento observable
        logger.warn("http unauthorized", {
          method: req.method,
          path,
          // Solo para distinguir "no manda cabecera" de "manda un token que no vale".
          has_authorization: Boolean(auth),
        });
        // Stryker restore all
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
            // Stryker disable next-line all : línea de log, no comportamiento observable
            logger.warn("http sin sesión", { session_id: sessionId, path });
            jsonError(res, 400, "No hay sesión: falta la petición 'initialize'.");
            return;
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport!);
              // Stryker disable next-line all : línea de log, no comportamiento observable
              logger.info("session opened", { session_id: sid, sessions: transports.size });
            },
          });
          transport.onclose = () => {
            if (transport!.sessionId) transports.delete(transport!.sessionId);
            // Stryker disable all : línea de log, no comportamiento observable
            logger.info("session closed", {
              session_id: transport!.sessionId,
              sessions: transports.size,
            });
            // Stryker restore all
          };
          await buildServer(client).connect(transport);
        }
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (!transport) {
          // Stryker disable next-line all : línea de log, no comportamiento observable
          logger.warn("http sesión no válida", { method: req.method, session_id: sessionId });
          jsonError(res, 400, "Sesión no válida o ausente (cabecera mcp-session-id).");
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      // Stryker disable next-line all : línea de log, no comportamiento observable
      logger.debug("http método no permitido", { method: req.method, path });
      jsonError(res, 405, "Método no permitido");
    } catch (err) {
      // Stryker disable next-line all : línea de log, no comportamiento observable
      logger.error("http request failed", { method: req.method, path, err });
      if (!res.headersSent) jsonError(res, 500, "Error interno");
    }
  });
}

/** Arranca el servidor HTTP y devuelve el handle (útil para cerrarlo en tests). */
export async function runHttp(
  client: AimHarderClient,
  opts: HttpOptions = httpOptionsFromEnv(),
): Promise<Server> {
  const httpServer = createMcpHttpServer(client, opts);
  await new Promise<void>((resolve) => httpServer.listen(opts.port, opts.host, resolve));
  logger.info("server started", {
    transport: "http",
    version: VERSION,
    host: opts.host,
    port: opts.port,
    path: opts.mcpPath,
    auth_required: Boolean(opts.token),
  });
  return httpServer;
}

/** Elige transporte según `--http` o MCP_TRANSPORT=http. */
export function useHttpTransport(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes("--http") || (env.MCP_TRANSPORT ?? "").toLowerCase() === "http";
}

/** Arranca el transporte que toque. Devuelve el server HTTP (si es el modo elegido). */
export async function main(client: AimHarderClient): Promise<Server | undefined> {
  if (useHttpTransport()) return runHttp(client);
  await runStdio(client);
  return undefined;
}
