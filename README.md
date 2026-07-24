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

## Instalación

```bash
npm install
npm run build
```

## Configuración

Credenciales por variables de entorno:

- `AIMHARDER_EMAIL`
- `AIMHARDER_PASSWORD`

### Claude Desktop / Claude Code

Añade a tu `claude_desktop_config.json` (o `.mcp.json`):

```json
{
  "mcpServers": {
    "fitbot": {
      "command": "node",
      "args": ["/ruta/absoluta/a/fitbot-mcp/dist/index.js"],
      "env": {
        "AIMHARDER_EMAIL": "tu@email.com",
        "AIMHARDER_PASSWORD": "tu_contraseña"
      }
    }
  }
}
```

Reinicia el cliente y pídele, por ejemplo: *"reserva la clase de CrossFit de mañana a las 18:15"*.

## Ejemplos de uso (lenguaje natural)

- "¿Qué clases hay hoy?" → `list_classes`
- "Apúntame al WOD de las 18:15" → `book_class { time: "18:15" }`
- "Cancela mi reserva de las 18:15" → `cancel_class { time: "18:15" }`
- "¿Quién va a la clase de las 18:15?" → `class_attendees` (ver nota)

## Notas

- **Apuntados a una clase**: AimHarder solo expone la lista de asistentes a cuentas con rol **coach/administrador** en el box. Para cuentas de cliente el endpoint (`/api/coachBookings`) devuelve vacío, y `class_attendees` lo indica en su respuesta.
- **Fingerprint**: en el primer arranque se genera un identificador de dispositivo estable y se guarda en `.fingerprint` (ignorado por git) para no acumular "dispositivos" en tu cuenta.
- **Multi-box**: si tu cuenta pertenece a varios boxes, usa `list_boxes` para ver los `boid` y pasa `boxId` a las demás herramientas.

## API (referencia interna)

- **Login**: `POST https://login.aimharder.com/api/login` — JSON `{ username, password, fingerprint, iniframe: 0 }`. Devuelve `data.userData.roles[].boid` / `centre_url` y cookies de sesión (`.aimharder.com`).
- **Horario**: `GET https://{subdominio}/api/bookings?day=YYYYMMDD&box={boid}&familyId=`
- **Reservar**: `POST https://{subdominio}/api/book` — form `{ id, day, insist, familyId }`. `bookState`: `1/0` ok · `-1` llena · `-2` sin tarifa · `-4/-7` antelación · `-5` pago pendiente.
- **Cancelar**: `POST https://{subdominio}/api/cancelBook` — form `{ id: idres, late, familyId }`. `cancelState: 1` = ok.
