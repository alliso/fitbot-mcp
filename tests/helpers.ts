import { vi } from "vitest";

/**
 * Respuesta HTTP falsa con lo justo que usa el cliente: `status`, `text()` y
 * unas cabeceras con o sin `getSetCookie()` (para cubrir los dos caminos de
 * `collectCookies`).
 */
export function fakeRes(opts: {
  body?: unknown;
  status?: number;
  setCookies?: string[];
  /** false => cabeceras "antiguas" sin getSetCookie(), solo el header combinado. */
  getSetCookie?: boolean;
}): any {
  const { body = {}, status = 200, setCookies = [], getSetCookie = true } = opts;
  const text = typeof body === "string" ? body : JSON.stringify(body);

  const headers: any = {
    get: (name: string) =>
      name.toLowerCase() === "set-cookie" && setCookies.length > 0 ? setCookies.join(", ") : null,
  };
  if (getSetCookie) headers.getSetCookie = () => setCookies;

  return { status, headers, text: async () => text };
}

export interface FetchCall {
  url: string;
  init: any;
  /** Cuerpo del POST ya parseado como pares clave/valor (form-urlencoded). */
  form: Record<string, string>;
  /** Cuerpo del POST parseado como JSON, si lo era. */
  json: any;
}

/**
 * Instala un `globalThis.fetch` falso que va consumiendo `queue`: cada entrada
 * es una respuesta (o una función que la produce) para la siguiente llamada.
 * Devuelve el registro de llamadas para poder afirmar sobre ellas.
 */
export function installFetch(queue: Array<any | ((call: FetchCall) => any)>) {
  const calls: FetchCall[] = [];

  const impl = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init?.body;
    let form: Record<string, string> = {};
    let json: any;
    if (typeof body === "string") {
      try {
        json = JSON.parse(body);
      } catch {
        form = Object.fromEntries(new URLSearchParams(body));
      }
    }
    const call: FetchCall = { url, init, form, json };
    calls.push(call);

    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`fetch inesperado (sin respuesta en cola): ${url}`);
    }
    const res = typeof next === "function" ? next(call) : next;
    if (res instanceof Error) throw res;
    return res;
  });

  vi.stubGlobal("fetch", impl);
  return { calls, impl };
}

/** Respuesta de login válida, con los campos que el cliente necesita. */
export function loginOk(overrides: Record<string, unknown> = {}) {
  return fakeRes({
    setCookies: ["PHPSESSID=abc123; Path=/; Domain=.aimharder.com", "amhrdrauth=tok; Path=/"],
    body: {
      data: {
        auth: { authOK: true },
        userData: {
          id: 42,
          name: "Ada",
          roles: [
            { boid: 100, centre_url: "mybox.aimharder.com", gym: "  Mi Box  ", role: "client" },
            { boid: 200, centre_url: "otro.aimharder.com", gym: "Otro Box", role: "coach" },
          ],
        },
      },
      ...overrides,
    },
  });
}

/** Una clase tal y como la devuelve /api/bookings. */
export function rawBooking(over: Record<string, unknown> = {}) {
  return {
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
    ...over,
  };
}
