import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { AimHarderClient, toApiDate } from "../src/aimharder.js";
import { fakeRes, installFetch, loginOk, rawBooking } from "./helpers.js";

const fs = {
  existsSync: vi.mocked(existsSync),
  readFileSync: vi.mocked(readFileSync),
  writeFileSync: vi.mocked(writeFileSync),
  mkdirSync: vi.mocked(mkdirSync),
};

/** Cliente ya logueado, para los tests que solo miran las llamadas posteriores. */
async function loggedIn(queue: any[] = []) {
  const fetchMock = installFetch([loginOk(), ...queue]);
  const client = new AimHarderClient("ada@example.com", "pw");
  await client.login();
  return { client, ...fetchMock };
}

beforeEach(() => {
  process.env.AIMHARDER_FINGERPRINT = "fp-de-test";
  fs.existsSync.mockReturnValue(false);
});

afterEach(() => {
  delete process.env.AIMHARDER_FINGERPRINT;
  vi.unstubAllGlobals();
});

describe("toApiDate", () => {
  it("usa el día de hoy si no se pasa fecha", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 4, 12, 0, 0)); // 4 de julio de 2026, hora local
    expect(toApiDate()).toBe("20260704");
    vi.useRealTimers();
  });

  it("acepta YYYY-MM-DD y YYYYMMDD", () => {
    expect(toApiDate("2026-07-24")).toBe("20260724");
    expect(toApiDate("20260724")).toBe("20260724");
    expect(toApiDate("2026/07/24")).toBe("20260724");
  });

  it("rechaza fechas con un número de dígitos distinto de 8", () => {
    expect(() => toApiDate("24-07")).toThrow(/Fecha inválida/);
    expect(() => toApiDate("2026-07-244")).toThrow(/YYYY-MM-DD/);
  });

  it("trata la cadena vacía como 'hoy' (no lanza)", () => {
    expect(toApiDate("")).toMatch(/^\d{8}$/);
  });
});

describe("fingerprint", () => {
  it("usa AIMHARDER_FINGERPRINT si está definido, sin tocar disco", async () => {
    const { calls } = await loggedIn();
    expect(calls[0].json.fingerprint).toBe("fp-de-test");
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it("lee el fingerprint persistido cuando no hay variable de entorno", async () => {
    delete process.env.AIMHARDER_FINGERPRINT;
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue("  fp-de-disco  " as any);

    const { calls } = await loggedIn();
    expect(calls[0].json.fingerprint).toBe("fp-de-disco");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("genera y persiste uno nuevo si no existe (50 chars [a-z0-9])", async () => {
    delete process.env.AIMHARDER_FINGERPRINT;

    const { calls } = await loggedIn();
    const fp = calls[0].json.fingerprint;
    expect(fp).toMatch(/^[a-f0-9]{50}$/);
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining(".fitbot-mcp"), {
      recursive: true,
    });
    expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), fp, "utf8");
  });

  it("genera uno nuevo si el fichero existe pero está vacío", async () => {
    delete process.env.AIMHARDER_FINGERPRINT;
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue("   " as any);

    const { calls } = await loggedIn();
    expect(calls[0].json.fingerprint).toMatch(/^[a-f0-9]{50}$/);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("sigue funcionando (fingerprint efímero) si no se puede escribir en disco", async () => {
    delete process.env.AIMHARDER_FINGERPRINT;
    fs.mkdirSync.mockImplementation(() => {
      throw new Error("EROFS: read-only file system");
    });

    const { calls } = await loggedIn();
    expect(calls[0].json.fingerprint).toMatch(/^[a-f0-9]{50}$/);
  });
});

describe("login", () => {
  it("manda las credenciales y guarda sesión, cookies y roles", async () => {
    const { client, calls } = await loggedIn();

    expect(calls[0].url).toBe("https://login.aimharder.com/api/login");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].json).toMatchObject({
      username: "ada@example.com",
      password: "pw",
      iniframe: 0,
    });

    const session = await client.login();
    expect(session.userId).toBe(42);
    expect(session.name).toBe("Ada");
    expect(session.cookies).toBe("PHPSESSID=abc123; amhrdrauth=tok");
    expect(session.roles).toEqual([
      { boid: 100, centreUrl: "mybox.aimharder.com", gym: "Mi Box", role: "client" },
      { boid: 200, centreUrl: "otro.aimharder.com", gym: "Otro Box", role: "coach" },
    ]);
  });

  it("es idempotente: no vuelve a llamar al login si ya hay sesión", async () => {
    const { client, impl } = await loggedIn();
    await client.login();
    await client.listRoles();
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("comparte una única petición entre logins concurrentes", async () => {
    const { impl } = installFetch([loginOk()]);
    const client = new AimHarderClient("ada@example.com", "pw");

    const [a, b, c] = await Promise.all([client.login(), client.login(), client.login()]);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("permite reintentar el login si el primero falla", async () => {
    installFetch([fakeRes({ body: { data: { auth: { authOK: false } } } }), loginOk()]);
    const client = new AimHarderClient("ada@example.com", "pw");

    await expect(client.login()).rejects.toThrow(/credenciales incorrectas/);
    await expect(client.login()).resolves.toMatchObject({ userId: 42 });
  });

  it("lee las cookies del header combinado si no hay getSetCookie()", async () => {
    installFetch([
      fakeRes({
        getSetCookie: false,
        setCookies: ["PHPSESSID=xyz; Path=/"],
        body: {
          data: {
            auth: { authOK: true },
            userData: { id: 1, name: "Ada", roles: [{ boid: 1, centre_url: "b.com", role: "client" }] },
          },
        },
      }),
    ]);
    const client = new AimHarderClient("a@b.c", "pw");
    const s = await client.login();
    expect(s.cookies).toBe("PHPSESSID=xyz");
    // gym ausente -> cadena vacía
    expect(s.roles[0].gym).toBe("");
  });

  it("ignora trozos de Set-Cookie sin '=' al principio", async () => {
    installFetch([
      fakeRes({
        setCookies: ["=sinNombre; Path=/", "ok=1; Path=/"],
        body: {
          data: {
            auth: { authOK: true },
            userData: { id: 1, name: "Ada", roles: [{ boid: 1, centre_url: "b.com", role: "client" }] },
          },
        },
      }),
    ]);
    const s = await new AimHarderClient("a@b.c", "pw").login();
    expect(s.cookies).toBe("ok=1");
  });

  it.each([
    ["respuesta no-JSON", fakeRes({ body: "<html>502</html>", status: 502 }), /Respuesta de login no válida \(HTTP 502\)/],
    ["authOK falso", fakeRes({ body: { data: { auth: { authOK: false } } } }), /credenciales incorrectas/],
    ["sin bloque auth", fakeRes({ body: { data: {} } }), /credenciales incorrectas/],
    [
      "sin userData",
      fakeRes({ body: { data: { auth: { authOK: true } } } }),
      /sin datos de usuario/,
    ],
    [
      "sin roles",
      fakeRes({ body: { data: { auth: { authOK: true }, userData: { id: 1, name: "A" } } } }),
      /no tiene ningún box asociado/,
    ],
    [
      "sin cookies",
      fakeRes({
        body: {
          data: {
            auth: { authOK: true },
            userData: { id: 1, name: "A", roles: [{ boid: 1, centre_url: "b.com", role: "client" }] },
          },
        },
      }),
      /no devolvió cookies de sesión/,
    ],
  ])("falla con %s", async (_name, res, expected) => {
    installFetch([res]);
    await expect(new AimHarderClient("a@b.c", "pw").login()).rejects.toThrow(expected);
  });
});

describe("selección de box", () => {
  it("usa el primer box si no se indica boxId", async () => {
    const { client, calls } = await loggedIn([fakeRes({ body: { bookings: [] } })]);
    await client.listClasses("2026-07-24");
    expect(calls[1].url).toContain("https://mybox.aimharder.com/api/bookings");
    expect(calls[1].url).toContain("box=100");
  });

  it("usa el box indicado por boxId", async () => {
    const { client, calls } = await loggedIn([fakeRes({ body: { bookings: [] } })]);
    await client.listClasses("2026-07-24", 200);
    expect(calls[1].url).toContain("https://otro.aimharder.com/api/bookings");
    expect(calls[1].url).toContain("box=200");
  });

  it("falla si el boxId no pertenece al usuario", async () => {
    const { client } = await loggedIn();
    await expect(client.listClasses("2026-07-24", 999)).rejects.toThrow(
      /No perteneces al box con id 999/,
    );
  });
});

describe("listClasses", () => {
  it("normaliza los campos que AimHarder puede omitir", async () => {
    const { client } = await loggedIn([
      fakeRes({
        body: {
          bookings: [
            rawBooking({ id: 1 }),
            { id: 2, time: "19:30 - 20:30", timeid: "1930_60", className: "WOD", ocupation: 12, limit: 12 },
          ],
        },
      }),
    ]);

    const classes = await client.listClasses("2026-07-24");
    expect(classes[0]).toEqual({
      id: 1,
      time: "18:15 - 19:15",
      timeid: "1815_60",
      className: "CROSSFIT",
      coachName: "Coach K",
      ocupation: 5,
      limit: 12,
      bookState: null,
      idres: null,
      waitlist: 0,
    });
    expect(classes[1]).toMatchObject({ coachName: null, bookState: null, idres: null, waitlist: -1 });
  });

  it("devuelve lista vacía si la respuesta no trae bookings", async () => {
    const { client } = await loggedIn([fakeRes({ body: {} })]);
    await expect(client.listClasses()).resolves.toEqual([]);
  });

  it("manda cookies, cabecera XHR y cache-buster", async () => {
    const { client, calls } = await loggedIn([fakeRes({ body: { bookings: [] } })]);
    await client.listClasses("2026-07-24");

    expect(calls[1].init.headers.Cookie).toBe("PHPSESSID=abc123; amhrdrauth=tok");
    expect(calls[1].init.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(calls[1].url).toMatch(/[?&]_=\d+/);
    expect(calls[1].url).toContain("day=20260724");
  });

  it("trata el cuerpo vacío como respuesta nula", async () => {
    const { client } = await loggedIn([fakeRes({ body: "   " })]);
    await expect(client.listClasses()).resolves.toEqual([]);
  });

  it("falla con respuesta no-JSON", async () => {
    const { client } = await loggedIn([fakeRes({ body: "<html>nope</html>", status: 500 })]);
    await expect(client.listClasses()).rejects.toThrow(
      /Respuesta no-JSON de \/api\/bookings \(HTTP 500\)/,
    );
  });
});

describe("findClass", () => {
  const clases = {
    bookings: [
      rawBooking({ id: 1, time: "07:00 - 08:00", className: "CROSSFIT" }),
      rawBooking({ id: 2, time: "18:15 - 19:15", className: "CROSSFIT" }),
      rawBooking({ id: 3, time: "18:15 - 19:15", className: "HALTEROFILIA" }),
    ],
  };

  it("encuentra por classId", async () => {
    const { client } = await loggedIn([fakeRes({ body: clases })]);
    const { booking, role, day } = await client.findClass({ date: "2026-07-24", classId: 3 });
    expect(booking.className).toBe("HALTEROFILIA");
    expect(role.boid).toBe(100);
    expect(day).toBe("20260724");
  });

  it("falla si el classId no está ese día", async () => {
    const { client } = await loggedIn([fakeRes({ body: clases })]);
    await expect(client.findClass({ date: "2026-07-24", classId: 99 })).rejects.toThrow(
      /No hay clase con id 99 el 20260724/,
    );
  });

  it("exige time o classId", async () => {
    const { client } = await loggedIn([fakeRes({ body: clases })]);
    await expect(client.findClass({ date: "2026-07-24" })).rejects.toThrow(/Indica 'time'.*o 'classId'/);
  });

  it("encuentra por hora de inicio, ignorando espacios", async () => {
    const { client } = await loggedIn([fakeRes({ body: { bookings: [clases.bookings[0]] } })]);
    const { booking } = await client.findClass({ date: "2026-07-24", time: " 07:00 " });
    expect(booking.id).toBe(1);
  });

  it("desambigua con name (sin distinguir mayúsculas)", async () => {
    const { client } = await loggedIn([fakeRes({ body: clases })]);
    const { booking } = await client.findClass({ date: "2026-07-24", time: "18:15", name: "halter" });
    expect(booking.id).toBe(3);
  });

  it("lista las clases disponibles cuando no hay ninguna a esa hora", async () => {
    const { client } = await loggedIn([fakeRes({ body: clases })]);
    await expect(client.findClass({ date: "2026-07-24", time: "22:00" })).rejects.toThrow(
      /No hay clase a las 22:00 el 20260724\. Disponibles: 07:00 - 08:00 CROSSFIT, /,
    );
  });

  it("dice '(ninguna)' si el día no tiene clases", async () => {
    const { client } = await loggedIn([fakeRes({ body: { bookings: [] } })]);
    await expect(client.findClass({ date: "2026-07-24", time: "22:00" })).rejects.toThrow(
      /Disponibles: \(ninguna\)/,
    );
  });

  it("pide desambiguar si hay varias coincidencias", async () => {
    const { client } = await loggedIn([fakeRes({ body: clases })]);
    await expect(client.findClass({ date: "2026-07-24", time: "18:15" })).rejects.toThrow(
      /Varias clases a las 18:15:.*Especifica 'name' o 'classId'/s,
    );
  });
});

describe("book", () => {
  const unaClase = { bookings: [rawBooking({ id: 7 })] };

  it("no vuelve a reservar si ya estabas apuntado", async () => {
    const { client, impl } = await loggedIn([
      fakeRes({ body: { bookings: [rawBooking({ id: 7, bookState: 1, idres: 555 })] } }),
    ]);

    const r = await client.book({ date: "2026-07-24", time: "18:15" });
    expect(r).toMatchObject({ ok: true, bookState: 1, message: "Ya tenías esta clase reservada.", reservationId: 555 });
    expect(impl).toHaveBeenCalledTimes(2); // login + bookings, sin POST /api/book
  });

  it("reserva y manda el formulario esperado", async () => {
    const { client, calls } = await loggedIn([
      fakeRes({ body: unaClase }),
      fakeRes({ body: { bookState: 1, id: 999 } }),
    ]);

    const r = await client.book({ date: "2026-07-24", time: "18:15", insist: true });
    expect(r).toMatchObject({ ok: true, bookState: 1, message: "Reserva confirmada", reservationId: 999 });
    expect(calls[2].url).toBe("https://mybox.aimharder.com/api/book");
    expect(calls[2].form).toEqual({ id: "7", day: "20260724", insist: "1", familyId: "" });
  });

  it("manda insist=0 por defecto", async () => {
    const { client, calls } = await loggedIn([
      fakeRes({ body: unaClase }),
      fakeRes({ body: { bookState: 1 } }),
    ]);
    await client.book({ date: "2026-07-24", classId: 7 });
    expect(calls[2].form.insist).toBe("0");
  });

  it("trata bookState 0 como éxito y sin reservationId", async () => {
    const { client } = await loggedIn([fakeRes({ body: unaClase }), fakeRes({ body: { bookState: "0" } })]);
    const r = await client.book({ date: "2026-07-24", classId: 7 });
    expect(r).toMatchObject({ ok: true, bookState: 0, message: "Reserva confirmada" });
    expect(r.reservationId).toBeUndefined();
  });

  it.each([
    [-1, /La clase está llena/],
    [-2, /ninguna tarifa contratada/],
    [-4, /con tanta antelación/],
    [-5, /pago pendiente/],
    [-7, /con tan poca antelación/],
  ])("traduce bookState %i", async (state, expected) => {
    const { client } = await loggedIn([fakeRes({ body: unaClase }), fakeRes({ body: { bookState: state } })]);
    const r = await client.book({ date: "2026-07-24", classId: 7 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(expected);
  });

  it("añade el detalle del servidor al mensaje conocido, limpiando el HTML", async () => {
    const { client } = await loggedIn([
      fakeRes({ body: unaClase }),
      fakeRes({ body: { bookState: -1, errorMssg: "<p>Máximo   3 clases</p>\n<b>por semana</b>" } }),
    ]);
    const r = await client.book({ date: "2026-07-24", classId: 7 });
    expect(r.message).toBe(
      "La clase está llena (usa insist=true para entrar en lista de espera) (Máximo 3 clases por semana)",
    );
  });

  it("no añade el detalle cuando la reserva ha ido bien", async () => {
    const { client } = await loggedIn([
      fakeRes({ body: unaClase }),
      fakeRes({ body: { bookState: 1, errorMssg: "aviso irrelevante" } }),
    ]);
    const r = await client.book({ date: "2026-07-24", classId: 7 });
    expect(r.message).toBe("Reserva confirmada");
  });

  it.each(["errorMssg", "errorMsg", "error", "message"])(
    "usa el texto del servidor de la clave %s cuando no hay bookState",
    async (key) => {
      const { client } = await loggedIn([
        fakeRes({ body: unaClase }),
        fakeRes({ body: { [key]: "Tarifa caducada" } }),
      ]);
      const r = await client.book({ date: "2026-07-24", classId: 7 });
      expect(r).toMatchObject({ ok: false, bookState: null, message: "No se pudo reservar: Tarifa caducada" });
    },
  );

  it("informa del estado desconocido si el número no está mapeado", async () => {
    const { client } = await loggedIn([fakeRes({ body: unaClase }), fakeRes({ body: { bookState: -99 } })]);
    const r = await client.book({ date: "2026-07-24", classId: 7 });
    expect(r.message).toBe("Respuesta desconocida (bookState=-99).");
  });

  it("vuelca la respuesta entera si no hay ni estado ni mensaje", async () => {
    const { client } = await loggedIn([
      fakeRes({ body: unaClase }),
      fakeRes({ body: { algo: "raro", bookState: "" } }),
    ]);
    const r = await client.book({ date: "2026-07-24", classId: 7 });
    expect(r.message).toBe('AimHarder no ha devuelto bookState. Respuesta: {"algo":"raro","bookState":""}');
  });

  it("ignora mensajes de servidor que no son texto o están vacíos", async () => {
    const { client } = await loggedIn([
      fakeRes({ body: unaClase }),
      fakeRes({ body: { bookState: -99, errorMssg: { code: 5 } } }),
    ]);
    const r = await client.book({ date: "2026-07-24", classId: 7 });
    expect(r.message).toBe("Respuesta desconocida (bookState=-99).");

    const b = await loggedIn([fakeRes({ body: unaClase }), fakeRes({ body: { errorMssg: "   <br/> " } })]);
    const r2 = await b.client.book({ date: "2026-07-24", classId: 7 });
    expect(r2.message).toMatch(/no ha devuelto bookState/);
  });

  it("falla con respuesta no-JSON (p.ej. una página de error del proxy)", async () => {
    const { client } = await loggedIn([
      fakeRes({ body: unaClase }),
      fakeRes({ body: "<html><body>502 Bad Gateway</body></html>", status: 502 }),
    ]);
    await expect(client.book({ date: "2026-07-24", classId: 7 })).rejects.toThrow(
      /Respuesta no-JSON de \/api\/book \(HTTP 502\): <html>/,
    );
  });

  it("trata un bookState no numérico como ausente", async () => {
    const { client } = await loggedIn([
      fakeRes({ body: unaClase }),
      fakeRes({ body: { bookState: "vaya" } }),
    ]);
    const r = await client.book({ date: "2026-07-24", classId: 7 });
    expect(r.bookState).toBeNull();
  });
});

describe("cancel", () => {
  it("no llama a la API si no hay reserva", async () => {
    const { client, impl } = await loggedIn([fakeRes({ body: { bookings: [rawBooking({ id: 7 })] } })]);
    const r = await client.cancel({ date: "2026-07-24", classId: 7 });
    expect(r).toMatchObject({ ok: false, cancelState: 0 });
    expect(r.message).toMatch(/no hay nada que cancelar/);
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("cancela y manda el idres, no el id de clase", async () => {
    const { client, calls } = await loggedIn([
      fakeRes({ body: { bookings: [rawBooking({ id: 7, bookState: 1, idres: 555 })] } }),
      fakeRes({ body: { cancelState: 1 } }),
    ]);

    const r = await client.cancel({ date: "2026-07-24", classId: 7, late: true });
    expect(r).toMatchObject({ ok: true, cancelState: 1, message: "Reserva cancelada." });
    expect(calls[2].url).toBe("https://mybox.aimharder.com/api/cancelBook");
    expect(calls[2].form).toEqual({ id: "555", late: "1", familyId: "" });
  });

  it("manda late=0 por defecto", async () => {
    const { client, calls } = await loggedIn([
      fakeRes({ body: { bookings: [rawBooking({ id: 7, idres: 555 })] } }),
      fakeRes({ body: { cancelState: 1 } }),
    ]);
    await client.cancel({ date: "2026-07-24", classId: 7 });
    expect(calls[2].form.late).toBe("0");
  });

  it("usa el mensaje del servidor si falla", async () => {
    const { client } = await loggedIn([
      fakeRes({ body: { bookings: [rawBooking({ id: 7, idres: 555 })] } }),
      fakeRes({ body: { cancelState: 0, errorMssg: "Fuera de plazo" } }),
    ]);
    const r = await client.cancel({ date: "2026-07-24", classId: 7 });
    expect(r).toMatchObject({ ok: false, message: "No se pudo cancelar: Fuera de plazo" });
  });

  it("informa del cancelState cuando no hay mensaje", async () => {
    const { client } = await loggedIn([
      fakeRes({ body: { bookings: [rawBooking({ id: 7, idres: 555 })] } }),
      fakeRes({ body: { cancelState: -3 } }),
    ]);
    const r = await client.cancel({ date: "2026-07-24", classId: 7 });
    expect(r.message).toBe("No se pudo cancelar (cancelState=-3).");
  });

  it("vuelca la respuesta si no hay ni cancelState ni mensaje", async () => {
    const { client } = await loggedIn([
      fakeRes({ body: { bookings: [rawBooking({ id: 7, idres: 555 })] } }),
      fakeRes({ body: { otra: "cosa" } }),
    ]);
    const r = await client.cancel({ date: "2026-07-24", classId: 7 });
    expect(r.message).toBe('AimHarder no ha devuelto cancelState. Respuesta: {"otra":"cosa"}');
  });
});

describe("attendees", () => {
  it("devuelve una nota si AimHarder no expone la lista", async () => {
    const { client } = await loggedIn([fakeRes({ body: "" })]);
    const r = await client.attendees({ date: "2026-07-24", time: "18:15" });
    expect(r.available).toBe(false);
    expect(r.attendees).toEqual([]);
    expect(r.note).toMatch(/rol actual es "client"/);
  });

  it("lee los apuntados buscando la clase por hora", async () => {
    const { client, calls } = await loggedIn([
      fakeRes({
        body: {
          bookings: [
            { id: 1, time: "07:00 - 08:00", athletes: [{ name: "Otro" }] },
            { id: 2, time: "18:15 - 19:15", athletes: [{ name: "Ada" }, { name: "Linus" }] },
          ],
        },
      }),
    ]);

    const r = await client.attendees({ date: "2026-07-24", time: "18:15" });
    expect(r).toEqual({ available: true, attendees: ["Ada", "Linus"] });
    expect(calls[1].url).toContain("/api/coachBookings");
  });

  it("busca por classId cuando se indica", async () => {
    const { client } = await loggedIn([
      fakeRes({ body: { bookings: [{ id: 9, time: "07:00", users: [{ userName: "Ada" }] }] } }),
    ]);
    const r = await client.attendees({ date: "2026-07-24", classId: 9 });
    expect(r.attendees).toEqual(["Ada"]);
  });

  it("acepta las variantes de estructura que devuelve AimHarder", async () => {
    const { client } = await loggedIn([
      fakeRes({
        body: {
          timetable: [{ id: 1, time: "10:00", athletesList: [{ athleteName: "Grace" }, "Ada", { nada: 1 }] }],
        },
      }),
    ]);
    const r = await client.attendees({ date: "2026-07-24", classId: 1 });
    expect(r.attendees).toEqual(["Grace", "Ada"]);
  });

  it("devuelve lista vacía si no se localiza la clase", async () => {
    const { client } = await loggedIn([fakeRes({ body: { bookings: [{ id: 1, time: "07:00" }] } })]);
    const r = await client.attendees({ date: "2026-07-24" });
    expect(r).toEqual({ available: true, attendees: [] });
  });
});

describe("sesión caducada ({ logout: 1 })", () => {
  it("renueva la sesión y repite el GET", async () => {
    const { client, calls, impl } = await loggedIn([
      fakeRes({ body: { logout: 1 } }),
      loginOk(),
      fakeRes({ body: { bookings: [rawBooking({ id: 1 })] } }),
    ]);

    const classes = await client.listClasses("2026-07-24");
    expect(classes).toHaveLength(1);
    expect(impl).toHaveBeenCalledTimes(4);
    expect(calls[2].url).toBe("https://login.aimharder.com/api/login");
    expect(calls[3].url).toContain("/api/bookings");
  });

  it("renueva la sesión y repite el POST", async () => {
    const { client, calls } = await loggedIn([
      fakeRes({ body: { bookings: [rawBooking({ id: 7 })] } }),
      fakeRes({ body: { logout: true } }),
      loginOk(),
      fakeRes({ body: { bookState: 1 } }),
    ]);

    const r = await client.book({ date: "2026-07-24", classId: 7 });
    expect(r.ok).toBe(true);
    expect(calls[4].url).toBe("https://mybox.aimharder.com/api/book");
    expect(calls[4].form.id).toBe("7");
  });

  it("se rinde si tras el re-login vuelve a decir logout", async () => {
    const { client } = await loggedIn([
      fakeRes({ body: { logout: "1" } }),
      loginOk(),
      fakeRes({ body: { logout: 1 } }),
    ]);

    await expect(client.listClasses("2026-07-24")).rejects.toThrow(
      /La sesión de AimHarder ha caducado y el re-login no la ha restablecido \(\/api\/bookings\)/,
    );
  });

  it("se rinde también en el POST tras el segundo logout", async () => {
    const { client } = await loggedIn([
      fakeRes({ body: { bookings: [rawBooking({ id: 7, idres: 5 })] } }),
      fakeRes({ body: { logout: 1 } }),
      loginOk(),
      fakeRes({ body: { logout: 1 } }),
    ]);

    await expect(client.cancel({ date: "2026-07-24", classId: 7 })).rejects.toThrow(
      /\/api\/cancelBook/,
    );
  });

  it("no confunde logout: 0 con sesión caducada", async () => {
    const { client } = await loggedIn([fakeRes({ body: { logout: 0, bookings: [] } })]);
    await expect(client.listClasses("2026-07-24")).resolves.toEqual([]);
  });
});
