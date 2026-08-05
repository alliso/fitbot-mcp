/**
 * Arranque de OpenTelemetry.
 *
 * Se carga con `node --import ./dist/tracing.js` (ver Dockerfile) para que las
 * instrumentaciones parcheen `node:http` antes de que la app lo importe. En
 * index.ts se importa además el primero de todos, así el orden se mantiene
 * aunque alguien arranque el proceso sin `--import`.
 *
 * Todo esto es opt-in: sin OTEL_EXPORTER_OTLP_ENDPOINT no se arranca nada, que
 * es lo que queremos en modo stdio (Claude Desktop lanza el server como
 * subproceso y ahí no hay ningún colector al que exportar).
 *
 * Config por entorno (nombres estándar de OTel, los lee el propio SDK):
 *   OTEL_EXPORTER_OTLP_ENDPOINT  p.ej. http://tempo.monitoring.svc.cluster.local:4318
 *   OTEL_SERVICE_NAME            nombre del servicio en Tempo
 *   OTEL_RESOURCE_ATTRIBUTES     atributos extra, p.ej. deployment.environment=prod
 */

import { register } from "node:module";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

export const tracingEnabled = Boolean(endpoint);

if (tracingEnabled) {
  // Este paquete es ESM ("type": "module"), y el parcheo por defecto de OTel va
  // por require(), que aquí no se ejecuta nunca: sin este loader la
  // instrumentación de node:http no engancha y no hay spans de servidor. Tiene
  // que registrarse antes de que se importe node:http, de ahí el --import.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const sdk = new NodeSDK({
    // El exporter lee OTEL_EXPORTER_OTLP_ENDPOINT y le añade /v1/traces.
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        // Las probes de kubelet pegan a /health cada pocos segundos: son ruido
        // puro y se comerían la retención de Tempo.
        ignoreIncomingRequestHook: (req) => (req.url ?? "").split("?")[0] === "/health",
      }),
      // Las llamadas a AimHarder van por el fetch global, que es undici. Esta
      // instrumentación va por diagnostics_channel, no parchea módulos.
      new UndiciInstrumentation(),
    ],
  });

  sdk.start();

  // Sin esto los spans en el buffer se pierden al reiniciar el pod.
  const shutdown = () => {
    sdk.shutdown().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

const tracer = trace.getTracer("fitbot-mcp");

/** Lo que devuelve el handler de una herramienta MCP, en lo que nos interesa. */
type ToolResult = { isError?: boolean };

/**
 * Envuelve `server.registerTool` para que cada llamada a una herramienta abra su
 * propio span.
 *
 * Se parchea el método en vez de tocar los cinco `registerTool` de index.ts
 * porque todas las herramientas entran por el mismo endpoint HTTP: sin esto, en
 * Tempo solo se vería `POST /fitbot` y no se distinguiría un `list_classes` de
 * un `book_class`. Los tipos del SDK se mantienen intactos — solo interceptamos
 * el último argumento, que siempre es el callback.
 */
export function instrumentMcpTools<T extends { registerTool: (...args: never[]) => unknown }>(
  server: T,
): T {
  if (!tracingEnabled) return server;

  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;

  (server as { registerTool: unknown }).registerTool = (...args: unknown[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as (...a: unknown[]) => Promise<ToolResult>;

    const traced = (...handlerArgs: unknown[]) =>
      tracer.startActiveSpan(`mcp.tool ${name}`, async (span: Span) => {
        span.setAttribute("mcp.tool.name", name);
        try {
          const result = await handler(...handlerArgs);
          // Una herramienta MCP señala el fallo con isError, no lanzando.
          if (result?.isError) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute("mcp.tool.is_error", true);
          }
          return result;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          span.end();
        }
      });

    return original(...args.slice(0, -1), traced);
  };

  return server;
}
