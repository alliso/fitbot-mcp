/**
 * Bootstrap: index.ts solo lee credenciales del entorno y arranca. Se mockea
 * `server.js` para que no levante ningún transporte, y `tracing.js` para no
 * cargar el SDK de OTel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const main = vi.fn(async () => {});
vi.mock("../src/server.js", () => ({ main }));
vi.mock("../src/tracing.js", () => ({
  tracingEnabled: false,
  instrumentMcpTools: (s: unknown) => s,
}));

/** Sentinela para cortar la ejecución donde el código real llamaría a process.exit. */
class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let written: any[];
let exit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  main.mockClear();
  main.mockResolvedValue(undefined);

  written = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    written.push(JSON.parse(String(chunk)));
    return true;
  });
  exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new ExitCalled(code);
  }) as any);

  process.env.AIMHARDER_EMAIL = "ada@example.com";
  process.env.AIMHARDER_PASSWORD = "pw";
});

afterEach(() => {
  delete process.env.AIMHARDER_EMAIL;
  delete process.env.AIMHARDER_PASSWORD;
});

const entry = (msg: string) => written.find((w) => w.msg === msg);

describe("arranque", () => {
  it("crea el cliente con las credenciales del entorno y arranca el server", async () => {
    await import("../src/index.js");
    // vi.resetModules() da una copia nueva del módulo: hay que pedir la clase
    // de esta misma generación para que el instanceof valga.
    const { AimHarderClient } = await import("../src/aimharder.js");

    expect(exit).not.toHaveBeenCalled();
    expect(main).toHaveBeenCalledOnce();
    expect(main.mock.calls[0][0]).toBeInstanceOf(AimHarderClient);
  });

  it.each([
    ["falta el email", { AIMHARDER_EMAIL: undefined, AIMHARDER_PASSWORD: "pw" }, false, true],
    ["falta la contraseña", { AIMHARDER_EMAIL: "ada@example.com", AIMHARDER_PASSWORD: undefined }, true, false],
    ["faltan las dos", { AIMHARDER_EMAIL: undefined, AIMHARDER_PASSWORD: undefined }, false, false],
    ["el email está vacío", { AIMHARDER_EMAIL: "", AIMHARDER_PASSWORD: "pw" }, false, true],
  ])("sale con código 1 si %s", async (_name, env, hasEmail, hasPassword) => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    await expect(import("../src/index.js")).rejects.toBeInstanceOf(ExitCalled);

    expect(exit).toHaveBeenCalledWith(1);
    expect(main).not.toHaveBeenCalled();
    expect(entry("faltan credenciales")).toMatchObject({
      level: "error",
      has_email: hasEmail,
      has_password: hasPassword,
      detail: expect.stringContaining("AIMHARDER_EMAIL"),
    });
  });

  it("loguea 'fatal' y sale con 1 si el arranque falla", async () => {
    main.mockRejectedValue(new Error("EADDRINUSE"));
    // Aquí el exit ocurre dentro de un .catch(): si lanzara, sería un rechazo
    // sin gestionar en lugar del final limpio que estamos comprobando.
    exit.mockImplementation((() => undefined) as any);

    await import("../src/index.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(entry("fatal")).toMatchObject({
      level: "error",
      err: { message: "EADDRINUSE" },
    });
  });
});
