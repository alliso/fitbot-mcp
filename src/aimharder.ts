/**
 * Cliente para la API (no oficial) de AimHarder.
 *
 * Flujo descubierto por ingeniería inversa del tráfico de la web:
 *
 *  1. Login:   POST https://login.aimharder.com/api/login
 *              JSON { username, password, fingerprint, iniframe: 0 }
 *              -> Set-Cookie (sesión en .aimharder.com) + data.userData.roles[].boid / centre_url
 *
 *  2. Horario: GET  https://{subdominio}/api/bookings?day=YYYYMMDD&box={boxId}&familyId=
 *              -> { bookings: [{ id, time, timeid, className, coachName, ocupation, limit, bookState, idres, ... }] }
 *
 *  3. Reservar:POST https://{subdominio}/api/book
 *              form { id, day: YYYYMMDD, insist, familyId }
 *              -> { bookState, id }   (1/0 ok, -1 llena, -2 sin tarifa, -4/-7 antelación, -5 pago pendiente)
 *
 *  4. Cancelar:POST https://{subdominio}/api/cancelBook
 *              form { id: idres, late, familyId }
 *              -> { cancelState }     (1 = ok)
 *
 *  5. Apuntados (solo coach/admin):
 *              GET  https://{subdominio}/api/coachBookings?day=YYYYMMDD&box={boxId}&familyId=
 *              -> vacío para cuentas "client".
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LOGIN_URL = "https://login.aimharder.com/api/login";
const __dirname = dirname(fileURLToPath(import.meta.url));
const FINGERPRINT_FILE = join(__dirname, "..", ".fingerprint");

/** bookState devuelto por /api/book */
const BOOK_STATE_MESSAGES: Record<number, string> = {
  1: "Reserva confirmada",
  0: "Reserva confirmada",
  [-1]: "La clase está llena (usa insist=true para entrar en lista de espera)",
  [-2]: "No tienes ninguna tarifa contratada que incluya esta clase",
  [-4]: "No puedes reservar con tanta antelación",
  [-5]: "No se pudo reservar: tienes un pago pendiente",
  [-7]: "No puedes reservar con tan poca antelación",
};

export interface Booking {
  /** id de la instancia de clase, necesario para /api/book */
  id: number;
  /** "18:15 - 19:15" */
  time: string;
  /** "1815_60" */
  timeid: string;
  className: string;
  coachName: string | null;
  ocupation: number;
  limit: number;
  /** null = no reservado, 1 = reservado por el usuario */
  bookState: number | null;
  /** id de la reserva del usuario (para cancelar); null si no está reservada */
  idres: number | null;
  waitlist: number;
}

export interface Role {
  boid: number;
  centreUrl: string;
  gym: string;
  role: string;
}

export interface Session {
  userId: number;
  name: string;
  roles: Role[];
  cookies: string; // cabecera Cookie ya formateada
}

function getFingerprint(): string {
  if (existsSync(FINGERPRINT_FILE)) {
    const fp = readFileSync(FINGERPRINT_FILE, "utf8").trim();
    if (fp) return fp;
  }
  // 50 caracteres [a-z0-9], estable entre ejecuciones para no acumular "dispositivos"
  const fp = randomBytes(40).toString("hex").slice(0, 50);
  try {
    writeFileSync(FINGERPRINT_FILE, fp, "utf8");
  } catch {
    /* si no se puede persistir, se usa uno efímero */
  }
  return fp;
}

/** Convierte "2026-07-24" (o "20260724") a "20260724". Por defecto, hoy. */
export function toApiDate(date?: string): string {
  if (!date) {
    const now = new Date();
    return (
      `${now.getFullYear()}` +
      String(now.getMonth() + 1).padStart(2, "0") +
      String(now.getDate()).padStart(2, "0")
    );
  }
  const digits = date.replace(/\D/g, "");
  if (digits.length !== 8) {
    throw new Error(`Fecha inválida: "${date}". Usa formato YYYY-MM-DD.`);
  }
  return digits;
}

/** Extrae los pares nombre=valor de las cabeceras Set-Cookie. */
function collectCookies(res: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  // Node/undici expone getSetCookie(); fallback a header combinado.
  const setCookies: string[] =
    typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export class AimHarderClient {
  private session: Session | null = null;

  constructor(
    private readonly email: string,
    private readonly password: string,
  ) {}

  /** Inicia sesión y guarda cookies + roles. Idempotente. */
  async login(): Promise<Session> {
    if (this.session) return this.session;

    const res = await fetch(LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        username: this.email,
        password: this.password,
        fingerprint: getFingerprint(),
        iniframe: 0,
      }),
    });

    const jar = collectCookies(res);
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Respuesta de login no válida (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }

    const auth = json?.data?.auth;
    if (!auth?.authOK) {
      throw new Error("Login fallido: credenciales incorrectas o cuenta bloqueada.");
    }
    const userData = json.data.userData;
    const roles: Role[] = (userData.roles ?? []).map((r: any) => ({
      boid: r.boid,
      centreUrl: r.centre_url,
      gym: (r.gym ?? "").trim(),
      role: r.role,
    }));

    if (roles.length === 0) {
      throw new Error("El usuario no tiene ningún box asociado.");
    }
    if (Object.keys(jar).length === 0) {
      throw new Error("El login no devolvió cookies de sesión.");
    }

    this.session = {
      userId: userData.id,
      name: userData.name,
      roles,
      cookies: cookieHeader(jar),
    };
    return this.session;
  }

  /**
   * Resuelve el box a usar. Si hay varios y no se indica boxId, usa el primero.
   */
  private resolveRole(boxId?: number): Role {
    const session = this.session!;
    if (boxId != null) {
      const role = session.roles.find((r) => r.boid === boxId);
      if (!role) throw new Error(`No perteneces al box con id ${boxId}.`);
      return role;
    }
    return session.roles[0];
  }

  async listRoles(): Promise<Role[]> {
    const s = await this.login();
    return s.roles;
  }

  private async apiGet(centreUrl: string, path: string, params: Record<string, string>): Promise<any> {
    const session = this.session!;
    const qs = new URLSearchParams({ ...params, _: String(Date.now()) });
    const res = await fetch(`https://${centreUrl}${path}?${qs}`, {
      headers: {
        Cookie: session.cookies,
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/plain, */*",
      },
    });
    const text = await res.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Respuesta no-JSON de ${path} (HTTP ${res.status}).`);
    }
  }

  private async apiPostForm(centreUrl: string, path: string, form: Record<string, string>): Promise<any> {
    const session = this.session!;
    const res = await fetch(`https://${centreUrl}${path}`, {
      method: "POST",
      headers: {
        Cookie: session.cookies,
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json, text/plain, */*",
      },
      body: new URLSearchParams(form).toString(),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Respuesta no-JSON de ${path} (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
  }

  /** Lista las clases de un día. */
  async listClasses(date?: string, boxId?: number): Promise<Booking[]> {
    await this.login();
    const role = this.resolveRole(boxId);
    const day = toApiDate(date);
    const data = await this.apiGet(role.centreUrl, "/api/bookings", {
      day,
      box: String(role.boid),
      familyId: "",
    });
    const bookings = (data?.bookings ?? []) as any[];
    return bookings.map((b) => ({
      id: b.id,
      time: b.time,
      timeid: b.timeid,
      className: b.className,
      coachName: b.coachName ?? null,
      ocupation: b.ocupation,
      limit: b.limit,
      bookState: b.bookState ?? null,
      idres: b.idres ?? null,
      waitlist: b.waitlist ?? -1,
    }));
  }

  /**
   * Busca una clase por hora de inicio ("18:15") y opcionalmente por nombre.
   * Lanza error si no hay coincidencia única.
   */
  async findClass(
    opts: { date?: string; boxId?: number; classId?: number; time?: string; name?: string },
  ): Promise<{ booking: Booking; role: Role; day: string }> {
    const role = this.resolveRole(opts.boxId);
    const day = toApiDate(opts.date);
    const classes = await this.listClasses(opts.date, opts.boxId);

    if (opts.classId != null) {
      const booking = classes.find((c) => c.id === opts.classId);
      if (!booking) throw new Error(`No hay clase con id ${opts.classId} el ${day}.`);
      return { booking, role, day };
    }

    if (!opts.time) {
      throw new Error("Indica 'time' (p.ej. \"18:15\") o 'classId'.");
    }
    const wantTime = opts.time.trim();
    let matches = classes.filter((c) => c.time.replace(/\s/g, "").startsWith(wantTime.replace(/\s/g, "")));
    if (opts.name) {
      const n = opts.name.toLowerCase();
      matches = matches.filter((c) => c.className.toLowerCase().includes(n));
    }
    if (matches.length === 0) {
      const available = classes.map((c) => `${c.time} ${c.className}`).join(", ");
      throw new Error(`No hay clase a las ${wantTime} el ${day}. Disponibles: ${available || "(ninguna)"}.`);
    }
    if (matches.length > 1) {
      const options = matches.map((c) => `${c.time} ${c.className}`).join(" | ");
      throw new Error(`Varias clases a las ${wantTime}: ${options}. Especifica 'name' o 'classId'.`);
    }
    return { booking: matches[0], role, day };
  }

  /** Reserva una clase. Devuelve el resultado con mensaje legible. */
  async book(
    opts: { date?: string; boxId?: number; classId?: number; time?: string; name?: string; insist?: boolean },
  ): Promise<{ ok: boolean; bookState: number; message: string; reservationId?: number; booking: Booking }> {
    const { booking, role, day } = await this.findClass(opts);

    if (booking.bookState === 1) {
      return {
        ok: true,
        bookState: 1,
        message: "Ya tenías esta clase reservada.",
        reservationId: booking.idres ?? undefined,
        booking,
      };
    }

    const resp = await this.apiPostForm(role.centreUrl, "/api/book", {
      id: String(booking.id),
      day,
      insist: opts.insist ? "1" : "0",
      familyId: "",
    });

    const bookState = Number(resp?.bookState);
    const ok = bookState === 1 || bookState === 0;
    return {
      ok,
      bookState,
      message: BOOK_STATE_MESSAGES[bookState] ?? `Respuesta desconocida (bookState=${bookState}).`,
      reservationId: resp?.id ? Number(resp.id) : undefined,
      booking,
    };
  }

  /** Cancela la reserva del usuario en una clase. */
  async cancel(
    opts: { date?: string; boxId?: number; classId?: number; time?: string; name?: string; late?: boolean },
  ): Promise<{ ok: boolean; cancelState: number; message: string; booking: Booking }> {
    const { booking, role } = await this.findClass(opts);

    if (!booking.idres) {
      return {
        ok: false,
        cancelState: 0,
        message: "No tienes reserva en esta clase, no hay nada que cancelar.",
        booking,
      };
    }

    const resp = await this.apiPostForm(role.centreUrl, "/api/cancelBook", {
      id: String(booking.idres),
      late: opts.late ? "1" : "0",
      familyId: "",
    });

    const cancelState = Number(resp?.cancelState);
    const ok = cancelState === 1;
    return {
      ok,
      cancelState,
      message: ok ? "Reserva cancelada." : `No se pudo cancelar (cancelState=${cancelState}).`,
      booking,
    };
  }

  /**
   * Lista quién está apuntado a una clase. Requiere rol coach/admin en el box;
   * para cuentas "client" AimHarder no expone la lista y devuelve vacío.
   */
  async attendees(
    opts: { date?: string; boxId?: number; classId?: number; time?: string; name?: string },
  ): Promise<{ available: boolean; attendees: string[]; note?: string }> {
    await this.login();
    const role = this.resolveRole(opts.boxId);
    const day = toApiDate(opts.date);

    const data = await this.apiGet(role.centreUrl, "/api/coachBookings", {
      day,
      box: String(role.boid),
      familyId: "",
    });

    if (!data) {
      return {
        available: false,
        attendees: [],
        note:
          "AimHarder no ha devuelto la lista de asistentes. Suele requerir permisos de coach/administrador en el box; " +
          `tu rol actual es "${role.role}".`,
      };
    }

    // Estructura coach: normalmente { bookings: [{ time/timeid, athletes/users: [{ name }] }] }
    const list: any[] = data.bookings ?? data.timetable ?? [];
    const wantTime = opts.time?.replace(/\s/g, "");
    const target = list.find((b: any) => {
      if (opts.classId != null) return b.id === opts.classId;
      if (wantTime) return String(b.time ?? "").replace(/\s/g, "").startsWith(wantTime);
      return false;
    });

    const rawAthletes: any[] =
      target?.athletes ?? target?.users ?? target?.bookings ?? target?.athletesList ?? [];
    const names = rawAthletes
      .map((a) => a?.name ?? a?.userName ?? a?.athleteName ?? (typeof a === "string" ? a : null))
      .filter(Boolean) as string[];

    return { available: true, attendees: names };
  }
}
