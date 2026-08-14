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
 * Logs en JSON a stderr (LOG_LEVEL): ver src/logger.ts.
 *
 * Este fichero es solo el arranque; el server y sus transportes viven en server.ts.
 */

// Primero de todos a propósito: arranca OpenTelemetry (si está configurado) antes
// de que se importe node:http, que es lo que la instrumentación tiene que parchear.
import "./tracing.js";
import { AimHarderClient } from "./aimharder.js";
import { main } from "./server.js";
import { logger } from "./logger.js";

const email = process.env.AIMHARDER_EMAIL;
const password = process.env.AIMHARDER_PASSWORD;

if (!email || !password) {
  logger.error("faltan credenciales", {
    detail: "define AIMHARDER_EMAIL y AIMHARDER_PASSWORD en el entorno",
    has_email: Boolean(email),
    has_password: Boolean(password),
  });
  process.exit(1);
}

main(new AimHarderClient(email, password)).catch((err) => {
  logger.error("fatal", { err });
  process.exit(1);
});
