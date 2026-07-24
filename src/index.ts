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
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

const server = new McpServer({
  name: "fitbot-mcp",
  version: "0.1.0",
});

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("fitbot-mcp en marcha (stdio).");
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
