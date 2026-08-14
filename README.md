# fitbot-mcp

Servidor [MCP](https://modelcontextprotocol.io) para **AimHarder**: reserva clases, consulta el horario y cancela reservas desde cualquier cliente MCP (Claude Desktop, Claude Code, etc.).

> API no oficial, obtenida por ingeniería inversa de la web. Puede dejar de funcionar si AimHarder cambia sus endpoints. Úsalo solo con tu propia cuenta.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `list_classes` | Lista las clases de un día: hora, nombre, coach, plazas y si estás apuntado. |
| `book_class` | Reserva una clase por hora (`"18:15"`) o por `classId`. `insist=true` → lista de espera. |
| `cancel_class` | Cancela tu reserva en una clase. |
| `class_attendees` | Lista los apuntados a una clase. **Solo para cuentas coach/admin** (ver nota abajo). |
| `list_boxes` | Muestra los boxes de tu cuenta y su `boid`. |

Todas aceptan `date` (`YYYY-MM-DD`, por defecto hoy) y, si perteneces a varios boxes, `boxId`.

## Configuración

Credenciales por variables de entorno: `AIMHARDER_EMAIL` y `AIMHARDER_PASSWORD`.

No hace falta clonar el repo: puedes ejecutarlo directamente con `npx`.

### Opción 1 — directo desde GitHub (sin publicar en npm)

`npx` clona y compila el paquete la primera vez (script `prepare`). Añade a tu
`claude_desktop_config.json` (Claude Desktop) o `.mcp.json` (Claude Code):

```json
{
  "mcpServers": {
    "fitbot": {
      "command": "npx",
      "args": ["-y", "github:alliso/fitbot-mcp"],
      "env": {
        "AIMHARDER_EMAIL": "tu@email.com",
        "AIMHARDER_PASSWORD": "tu_contraseña"
      }
    }
  }
}
```

### Opción 2 — desde npm (si lo publicas)

Tras `npm publish --access public`, la config es aún más corta:

```json
{
  "mcpServers": {
    "fitbot": {
      "command": "npx",
      "args": ["-y", "fitbot-mcp"],
      "env": {
        "AIMHARDER_EMAIL": "tu@email.com",
        "AIMHARDER_PASSWORD": "tu_contraseña"
      }
    }
  }
}
```

### Opción 3 — instalación local (desarrollo)

```bash
git clone https://github.com/alliso/fitbot-mcp.git
cd fitbot-mcp && npm install && npm run build
```

y usa `"command": "node", "args": ["/ruta/a/fitbot-mcp/dist/index.js"]`.

Reinicia el cliente y pídele, por ejemplo: *"reserva la clase de CrossFit de mañana a las 18:15"*.

## Tests

```bash
npm test          # suite completa (vitest)
npm run test:watch
npm run coverage  # informe + umbrales (text, html en coverage/, lcov)
```

Los tests no tocan la red ni AimHarder: el `fetch` global va mockeado y se
inyecta un cliente de mentira en el server MCP. El transporte HTTP sí se prueba
de verdad, levantando el servidor en un puerto libre y hablándole con el cliente
del MCP SDK.

| Fichero | Qué cubre |
|---|---|
| `tests/aimharder.test.ts` | Login, fingerprint, cookies, mapeo de clases, reserva/cancelación, re-login tras `{logout:1}`. |
| `tests/server.test.ts` | Las cinco herramientas MCP vía transporte en memoria, y el formato de salida. |
| `tests/server-http.test.ts` | Rutas, `Bearer` token, ciclo de sesión Streamable HTTP y casos límite del handler. |
| `tests/server-stdio.test.ts` | Modo stdio y elección de transporte en `main()`. |
| `tests/logger.test.ts` | Niveles, formato JSON, serialización de errores, correlación con trazas. |
| `tests/tracing*.test.ts` | Instrumentación de herramientas con OTel activado y desactivado. |
| `tests/index.test.ts` | Arranque y validación de credenciales. |

### Tests de mutación

El coverage dice qué líneas se ejecutan, no si alguien comprueba el resultado.
[StrykerJS](https://stryker-mutator.io/) introduce cambios pequeños en `src/`
(invertir un `if`, cambiar un `+` por `-`, vaciar un string) y da por buena la
suite solo si algún test se pone en rojo.

```bash
npm run test:mutation   # informe HTML en reports/mutation/index.html
```

Tarda alrededor de un minuto. El umbral de corte está en un 85% de mutation
score; por debajo, el comando falla.

Lo que **no** se mutila, marcado con `// Stryker disable` en el propio código:
las descripciones de las herramientas MCP (prosa dirigida al LLM: afirmar sobre
ella en un test solo estorba al reescribirla), las líneas de `logger.*` y algún
mutante equivalente suelto. Sin esos, el score mezclaba huecos reales con texto
y no servía como señal.

## Modo HTTP (para n8n y otros clientes remotos)

Además de stdio, el server puede arrancar como servicio HTTP con **URL propia**
(transporte *Streamable HTTP* del MCP SDK), sin necesidad de gateways.

```bash
# desde el repo (o npx -y github:alliso/fitbot-mcp --http)
AIMHARDER_EMAIL=tu@email.com AIMHARDER_PASSWORD=tu_contraseña \
  PORT=8000 HOST=0.0.0.0 \
  node dist/index.js --http
```

Endpoint MCP: `http://<host>:8000/mcp` — y `GET /health` para healthcheck.

Variables de entorno:

| Var | Por defecto | Descripción |
|---|---|---|
| `PORT` | `8000` | Puerto de escucha. |
| `HOST` | `127.0.0.1` | Interfaz. Usa `0.0.0.0` en Docker/contenedores. |
| `MCP_HTTP_PATH` | `/mcp` | Ruta del endpoint. |
| `MCP_HTTP_TOKEN` | — | Si se define, exige `Authorization: Bearer <token>`. **Recomendado** si el puerto es accesible por la red. |

También puedes activarlo con `MCP_TRANSPORT=http` en vez del flag `--http`.

## Logs

El server escribe logs estructurados (**una línea JSON por evento**) siempre a
**stderr** — nunca a stdout, que en modo stdio es el canal del protocolo MCP.

```json
{"ts":"2026-08-13T10:22:31.004Z","level":"info","msg":"tool ok","tool":"book_class","args":{"time":"18:15"},"duration_ms":412,"trace_id":"4bf92f…","span_id":"00f067…"}
```

| Var | Por defecto | Descripción |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` o `silent` (apaga los logs). |

Qué se registra:

- **Ciclo de vida**: arranque (`server started`, con transporte, puerto y si exige token), parada, apertura y cierre de sesiones HTTP.
- **Herramientas**: una línea por invocación con el nombre, los argumentos y la duración — `tool ok`, `tool error` (la herramienta devuelve `isError`) o `tool failed` (excepción, con el stack).
- **Errores**: peticiones HTTP fallidas, `401` por token inválido, sesión ausente o caducada y errores fatales.
- Con `LOG_LEVEL=debug` se añaden `tool start` y los `404`/`405` del endpoint HTTP.

No se registran nunca credenciales, cookies de sesión ni el token de `MCP_HTTP_TOKEN`.

Si el tracing está activo (ver abajo), cada línea lleva `trace_id`/`span_id` del
span en curso, así se salta desde un log (Loki) a su traza (Tempo). En Docker/k8s
basta con recoger la salida del contenedor: no hay ficheros de log.

## Trazas (OpenTelemetry)

Opcional y desactivado por defecto: si defines `OTEL_EXPORTER_OTLP_ENDPOINT`, el
server exporta trazas por OTLP HTTP a ese colector (Tempo, Jaeger, el OTel
Collector…). Sin esa variable no se arranca el SDK, que es lo que interesa en
modo stdio.

| Var | Descripción |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Colector OTLP HTTP, p.ej. `http://tempo:4318`. El exporter le añade `/v1/traces`. |
| `OTEL_SERVICE_NAME` | Nombre del servicio en el backend de trazas. |
| `OTEL_RESOURCE_ATTRIBUTES` | Atributos extra, p.ej. `service.namespace=home-utils`. |

Cada petición produce un span de servidor, un span `mcp.tool <nombre>` por
herramienta invocada y un span de cliente por cada llamada a AimHarder:

```
POST /mcp
└── mcp.tool list_classes
    └── POST login.aimharder.com/api/login
```

Las probes a `/health` se ignoran. Un fallo de herramienta marca el span como
error y adjunta la excepción.

### Conectarlo desde n8n (self-hosted)

1. Arranca el server en modo HTTP en una máquina accesible desde n8n (mismo host,
   otra máquina de la red, o un contenedor en el mismo `docker-compose`).
2. En n8n, dentro de tu **AI Agent**, añade el nodo **MCP Client Tool**.
3. Transporte **HTTP Streamable** (o SSE, según versión) y **Endpoint**:
   `http://<host>:8000/mcp`
   - Si defines `MCP_HTTP_TOKEN`, añade en el nodo la cabecera
     `Authorization: Bearer <token>`.
4. Si n8n corre en Docker y el server en el host, usa `http://host.docker.internal:8000/mcp`.

> Alternativa sin modo HTTP: el community node `n8n-nodes-mcp` permite conexión
> **STDIO** con `command: npx`, `args: -y github:alliso/fitbot-mcp` y las variables
> de entorno de credenciales (requiere Node/npx dentro del contenedor de n8n).

## Ejemplos de uso (lenguaje natural)

- "¿Qué clases hay hoy?" → `list_classes`
- "Apúntame al WOD de las 18:15" → `book_class { time: "18:15" }`
- "Cancela mi reserva de las 18:15" → `cancel_class { time: "18:15" }`
- "¿Quién va a la clase de las 18:15?" → `class_attendees` (ver nota)

## Notas

- **Apuntados a una clase**: AimHarder solo expone la lista de asistentes a cuentas con rol **coach/administrador** en el box. Para cuentas de cliente el endpoint (`/api/coachBookings`) devuelve vacío, y `class_attendees` lo indica en su respuesta.
- **Fingerprint**: en el primer arranque se genera un identificador de dispositivo estable y se guarda en `~/.fitbot-mcp/fingerprint` (en tu carpeta de usuario, para que persista aunque se ejecute vía `npx`). Puedes fijarlo con la variable `AIMHARDER_FINGERPRINT`.
- **Sesión caducada**: la cookie de login no dura para siempre. Si AimHarder responde `{"logout":1}` (pasa en servidores de larga vida), el cliente vuelve a autenticarse y repite la llamada una vez; solo si falla otra vez devuelve error.
- **Multi-box**: si tu cuenta pertenece a varios boxes, usa `list_boxes` para ver los `boid` y pasa `boxId` a las demás herramientas.

## API (referencia interna)

- **Login**: `POST https://login.aimharder.com/api/login` — JSON `{ username, password, fingerprint, iniframe: 0 }`. Devuelve `data.userData.roles[].boid` / `centre_url` y cookies de sesión (`.aimharder.com`).
- **Horario**: `GET https://{subdominio}/api/bookings?day=YYYYMMDD&box={boid}&familyId=`
- **Reservar**: `POST https://{subdominio}/api/book` — form `{ id, day, insist, familyId }`. `bookState`: `1/0` ok · `-1` llena · `-2` sin tarifa · `-4/-7` antelación · `-5` pago pendiente.
- **Cancelar**: `POST https://{subdominio}/api/cancelBook` — form `{ id: idres, late, familyId }`. `cancelState: 1` = ok.
- **Sesión caducada**: cualquiera de los endpoints anteriores puede responder `{ logout: 1 }` en lugar del estado esperado; significa que hay que rehacer el login.
