import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildServer,
  formatBooking,
  httpOptionsFromEnv,
  useHttpTransport,
  VERSION,
} from "../src/server.js";
import type { Booking } from "../src/aimharder.js";

function booking(over: Partial<Booking> = {}): Booking {
  return {
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
    ...over,
  };
}

/** Cliente de AimHarder de mentira: el server MCP solo lo usa a través de estos métodos. */
function stubClient() {
  return {
    listClasses: vi.fn(async () => [] as Booking[]),
    book: vi.fn(async () => ({ ok: true, bookState: 1, message: "Reserva confirmada", booking: booking() })),
    cancel: vi.fn(async () => ({ ok: true, cancelState: 1, message: "Reserva cancelada.", booking: booking() })),
    attendees: vi.fn(async () => ({ available: true, attendees: [] as string[] })),
    listRoles: vi.fn(async () => []),
  };
}

/** Conecta un Client MCP real al server por transporte en memoria. */
async function connect(aim: ReturnType<typeof stubClient>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(aim as any);
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

/** Texto plano devuelto por una herramienta. */
async function callText(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res: any = await client.callTool({ name, arguments: args });
  return { text: res.content.map((c: any) => c.text).join("\n"), isError: Boolean(res.isError) };
}

let mcp: Awaited<ReturnType<typeof connect>> | null = null;
let aim: ReturnType<typeof stubClient>;

beforeEach(() => {
  // stderr limpio: el server loguea cada llamada a herramienta.
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  aim = stubClient();
});

afterEach(async () => {
  await mcp?.close();
  mcp = null;
});

describe("formatBooking", () => {
  it("muestra hora, nombre, coach, plazas e id", () => {
    expect(formatBooking(booking())).toBe("18:15 - 19:15  CROSSFIT · Coach K  [5/12]  (id=7)");
  });

  it("omite el coach si no lo hay", () => {
    expect(formatBooking(booking({ coachName: null }))).toBe("18:15 - 19:15  CROSSFIT  [5/12]  (id=7)");
  });

  it("marca (LLENA) cuando no quedan plazas", () => {
    expect(formatBooking(booking({ ocupation: 12 }))).toContain("[12/12] (LLENA)");
    expect(formatBooking(booking({ ocupation: 13 }))).toContain("(LLENA)");
  });

  it("marca RESERVADA si bookState es 1", () => {
    expect(formatBooking(booking({ bookState: 1 }))).toContain("✅ RESERVADA");
    expect(formatBooking(booking({ bookState: 0 }))).not.toContain("RESERVADA");
  });

  it("combina LLENA y RESERVADA", () => {
    const text = formatBooking(booking({ ocupation: 12, bookState: 1 }));
    expect(text).toBe("18:15 - 19:15  CROSSFIT · Coach K  [12/12] (LLENA) ✅ RESERVADA  (id=7)");
  });
});

describe("registro de herramientas", () => {
  it("expone las cinco herramientas con título y esquema", async () => {
    mcp = await connect(aim);
    const { tools } = await mcp.client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "book_class",
      "cancel_class",
      "class_attendees",
      "list_boxes",
      "list_classes",
    ]);
    const book = tools.find((t) => t.name === "book_class")!;
    expect(book.title).toBe("Reservar clase");
    expect(Object.keys(book.inputSchema.properties ?? {}).sort()).toEqual([
      "boxId",
      "classId",
      "date",
      "insist",
      "name",
      "time",
    ]);
    // Todos los argumentos son opcionales.
    expect(book.inputSchema.required ?? []).toEqual([]);
  });

  it("anuncia nombre y versión del server", async () => {
    mcp = await connect(aim);
    expect(mcp.client.getServerVersion()).toMatchObject({ name: "fitbot-mcp", version: VERSION });
  });

  it("rechaza argumentos del tipo equivocado antes de llegar al cliente", async () => {
    mcp = await connect(aim);
    const r = await callText(mcp.client, "list_classes", { boxId: "cien" });
    expect(r.isError).toBe(true);
    expect(aim.listClasses).not.toHaveBeenCalled();
  });

  it("falla al llamar a una herramienta inexistente", async () => {
    mcp = await connect(aim);
    const { text, isError } = await callText(mcp.client, "no_existe");
    expect(isError).toBe(true);
    expect(text).toContain("Tool no_existe not found");
  });
});

describe("list_classes", () => {
  it("lista una clase por línea", async () => {
    aim.listClasses.mockResolvedValue([booking({ id: 1, time: "07:00 - 08:00" }), booking({ id: 2 })]);
    mcp = await connect(aim);

    const { text, isError } = await callText(mcp.client, "list_classes", { date: "2026-07-24" });
    expect(isError).toBe(false);
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("(id=1)");
    expect(aim.listClasses).toHaveBeenCalledWith("2026-07-24", undefined);
  });

  it("avisa si el día no tiene clases", async () => {
    mcp = await connect(aim);
    const { text } = await callText(mcp.client, "list_classes");
    expect(text).toBe("No hay clases para ese día.");
  });

  it("pasa el boxId al cliente", async () => {
    mcp = await connect(aim);
    await callText(mcp.client, "list_classes", { date: "2026-07-24", boxId: 200 });
    expect(aim.listClasses).toHaveBeenCalledWith("2026-07-24", 200);
  });

  it("propaga el error del cliente como isError", async () => {
    aim.listClasses.mockRejectedValue(new Error("Login fallido"));
    mcp = await connect(aim);

    const { text, isError } = await callText(mcp.client, "list_classes");
    expect(isError).toBe(true);
    expect(text).toContain("Login fallido");
  });
});

describe("book_class", () => {
  it("confirma la reserva con la clase formateada y el id de reserva", async () => {
    aim.book.mockResolvedValue({
      ok: true,
      bookState: 1,
      message: "Reserva confirmada",
      reservationId: 999,
      booking: booking({ bookState: 1 }),
    } as any);
    mcp = await connect(aim);

    const { text, isError } = await callText(mcp.client, "book_class", {
      date: "2026-07-24",
      time: "18:15",
      insist: true,
    });

    expect(isError).toBe(false);
    expect(text).toMatch(/^✅ 18:15 - 19:15 {2}CROSSFIT/);
    expect(text).toContain("Reserva confirmada (reserva id=999)");
    expect(aim.book).toHaveBeenCalledWith({
      date: "2026-07-24",
      time: "18:15",
      classId: undefined,
      name: undefined,
      insist: true,
      boxId: undefined,
    });
  });

  it("omite el id de reserva si no viene", async () => {
    mcp = await connect(aim);
    const { text } = await callText(mcp.client, "book_class", { classId: 7 });
    expect(text).not.toContain("reserva id=");
  });

  it("marca isError y usa ❌ cuando falla", async () => {
    aim.book.mockResolvedValue({
      ok: false,
      bookState: -1,
      message: "La clase está llena",
      booking: booking({ ocupation: 12 }),
    } as any);
    mcp = await connect(aim);

    const { text, isError } = await callText(mcp.client, "book_class", { time: "18:15" });
    expect(isError).toBe(true);
    expect(text).toContain("❌");
    expect(text).toContain("(LLENA)");
    expect(text).toContain("La clase está llena");
  });
});

describe("cancel_class", () => {
  it("confirma la cancelación", async () => {
    mcp = await connect(aim);
    const { text, isError } = await callText(mcp.client, "cancel_class", { classId: 7, late: true });

    expect(isError).toBe(false);
    expect(text).toMatch(/^✅ /);
    expect(text).toContain("Reserva cancelada.");
    expect(aim.cancel).toHaveBeenCalledWith({
      date: undefined,
      time: undefined,
      classId: 7,
      name: undefined,
      late: true,
      boxId: undefined,
    });
  });

  it("marca isError si no se pudo cancelar", async () => {
    aim.cancel.mockResolvedValue({
      ok: false,
      cancelState: 0,
      message: "No tienes reserva en esta clase, no hay nada que cancelar.",
      booking: booking(),
    } as any);
    mcp = await connect(aim);

    const { text, isError } = await callText(mcp.client, "cancel_class", { classId: 7 });
    expect(isError).toBe(true);
    expect(text).toContain("❌");
    expect(text).toContain("no hay nada que cancelar");
  });
});

describe("class_attendees", () => {
  it("numera a los apuntados", async () => {
    aim.attendees.mockResolvedValue({ available: true, attendees: ["Ada", "Linus"] });
    mcp = await connect(aim);

    const { text } = await callText(mcp.client, "class_attendees", { time: "18:15" });
    expect(text).toBe("2 apuntados:\n1. Ada\n2. Linus");
  });

  it("explica que la lista está vacía", async () => {
    mcp = await connect(aim);
    const { text } = await callText(mcp.client, "class_attendees", { time: "18:15" });
    expect(text).toBe("No hay nadie apuntado (o no se pudo leer la lista).");
  });

  it("devuelve la nota cuando AimHarder no expone la lista", async () => {
    aim.attendees.mockResolvedValue({ available: false, attendees: [], note: "Necesitas rol de coach." } as any);
    mcp = await connect(aim);

    const { text, isError } = await callText(mcp.client, "class_attendees", { time: "18:15" });
    expect(text).toBe("Necesitas rol de coach.");
    expect(isError).toBe(false);
  });

  it("tiene un texto por defecto si no hay nota", async () => {
    aim.attendees.mockResolvedValue({ available: false, attendees: [] } as any);
    mcp = await connect(aim);

    const { text } = await callText(mcp.client, "class_attendees", { time: "18:15" });
    expect(text).toBe("Lista no disponible.");
  });
});

describe("list_boxes", () => {
  it("muestra gimnasio, boid, rol y subdominio", async () => {
    aim.listRoles.mockResolvedValue([
      { boid: 100, centreUrl: "mybox.aimharder.com", gym: "Mi Box", role: "client" },
      { boid: 200, centreUrl: "otro.aimharder.com", gym: "Otro Box", role: "coach" },
    ] as any);
    mcp = await connect(aim);

    const { text } = await callText(mcp.client, "list_boxes");
    expect(text).toBe(
      "Mi Box  (boid=100, rol=client, mybox.aimharder.com)\n" +
        "Otro Box  (boid=200, rol=coach, otro.aimharder.com)",
    );
  });

  it("no necesita argumentos", async () => {
    mcp = await connect(aim);
    const { isError } = await callText(mcp.client, "list_boxes");
    expect(isError).toBe(false);
    expect(aim.listRoles).toHaveBeenCalledOnce();
  });
});

describe("configuración por entorno", () => {
  it("httpOptionsFromEnv trae los valores por defecto", () => {
    expect(httpOptionsFromEnv({})).toEqual({
      port: 8000,
      host: "127.0.0.1",
      mcpPath: "/mcp",
      token: undefined,
    });
  });

  it("httpOptionsFromEnv respeta las variables", () => {
    expect(
      httpOptionsFromEnv({
        PORT: "9000",
        HOST: "0.0.0.0",
        MCP_HTTP_PATH: "/fitbot",
        MCP_HTTP_TOKEN: "  secreto  ",
      }),
    ).toEqual({ port: 9000, host: "0.0.0.0", mcpPath: "/fitbot", token: "secreto" });
  });

  it("un token en blanco equivale a no exigir autenticación", () => {
    expect(httpOptionsFromEnv({ MCP_HTTP_TOKEN: "   " }).token).toBeUndefined();
  });

  it.each([
    [["node", "index.js", "--http"], {}, true],
    [["node", "index.js"], { MCP_TRANSPORT: "http" }, true],
    [["node", "index.js"], { MCP_TRANSPORT: "HTTP" }, true],
    [["node", "index.js"], { MCP_TRANSPORT: "stdio" }, false],
    [["node", "index.js"], {}, false],
  ])("useHttpTransport(%j, %j) === %s", (argv, env, expected) => {
    expect(useHttpTransport(argv as string[], env as NodeJS.ProcessEnv)).toBe(expected);
  });
});
