/** Operational telemetry for the detached shipper. Never imported by capture.ts. */
import { context, metrics, propagation, trace, SpanKind, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const SAFE = /^(?:service\.version|operation\.name|http\.request\.method|http\.route|http\.response\.status_code|error\.type|augenta\.(?:connector\.id|workspace\.id|count|bytes|stage|reason))$/;
const LOW_CARDINALITY_METRIC = /^(?:operation\.name|http\.request\.method|http\.route|http\.response\.status_code|error\.type|augenta\.(?:stage|reason))$/;

export function safePluginAttributes(input: Attributes): Attributes {
  return Object.fromEntries(Object.entries(input).filter(([key, value]) =>
    SAFE.test(key) && ["string", "number", "boolean"].includes(typeof value)));
}

export function lowCardinalityMetricAttributes(input: Attributes): Attributes {
  return Object.fromEntries(Object.entries(safePluginAttributes(input))
    .filter(([key]) => LOW_CARDINALITY_METRIC.test(key)));
}

function authHeaders(token: string | undefined, connectorId: string | undefined, oauth: boolean): Record<string, string> {
  return token ? {
    authorization: oauth ? `Bearer ${token}` : `AugentaKey ${token}`,
    ...(oauth && connectorId ? { "x-augenta-connector-id": connectorId } : {}),
  } : {};
}

export interface PluginTelemetry {
  upload<T>(attributes: Attributes, fn: (headers: Record<string, string>) => Promise<T>): Promise<T>;
  recordDrain(attributes: Attributes): void;
  recordRetry(attributes: Attributes): void;
  event(name: string, attributes: Attributes): void;
  flush(timeoutMillis?: number): Promise<void>;
}

/** Existing project connection consent is the switch; no config means this is never called. */
export function createPluginTelemetry(options: {
  gateway: string;
  token?: string;
  connectorId?: string;
  oauth: boolean;
  version: string;
}): PluginTelemetry {
  const base = `${options.gateway.replace(/\/$/, "")}/v1/telemetry`;
  const headers = authHeaders(options.token, options.connectorId, options.oauth);
  const resource = resourceFromAttributes({ "service.name": "augenta-plugin", "service.version": options.version });
  const traceProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${base}/traces`, headers }),
      { scheduledDelayMillis: 1_000, exportTimeoutMillis: 1_000 })],
  });
  traceProvider.register();
  const metricProvider = new MeterProvider({ resource, readers: [new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${base}/metrics`, headers }), exportIntervalMillis: 1_000,
  })] });
  metrics.setGlobalMeterProvider(metricProvider);
  const logProvider = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({
    exporter: new OTLPLogExporter({ url: `${base}/logs`, headers }), scheduledDelayMillis: 1_000, exportTimeoutMillis: 1_000,
  })] });
  logs.setGlobalLoggerProvider(logProvider);
  const tracer = traceProvider.getTracer("ai.augenta.plugin");
  const meter = metricProvider.getMeter("ai.augenta.plugin");
  const logger = logProvider.getLogger("ai.augenta.plugin");
  const uploads = meter.createCounter("augenta.plugin.uploads");
  const duration = meter.createHistogram("augenta.plugin.upload.duration", { unit: "ms" });
  const shipped = meter.createCounter("augenta.plugin.records.shipped");
  const uploadBytes = meter.createHistogram("augenta.plugin.upload.bytes", { unit: "By" });
  const drains = meter.createCounter("augenta.plugin.drains");
  const retries = meter.createCounter("augenta.plugin.retries");
  const failures = meter.createCounter("augenta.plugin.failures");
  const outbox = meter.createHistogram("augenta.plugin.outbox.bytes", { unit: "By" });

  return {
    async upload<T>(attributes: Attributes, fn: (headers: Record<string, string>) => Promise<T>): Promise<T> {
      const attrs = safePluginAttributes(attributes);
      const metricAttrs = lowCardinalityMetricAttributes(attrs);
      let invoked = false;
      let succeeded = false;
      let completed: T | undefined;
      try {
        return await tracer.startActiveSpan("plugin.experiences.upload", { kind: SpanKind.CLIENT, attributes: attrs }, async (span) => {
          const started = performance.now();
          const propagated: Record<string, string> = {};
          try {
            propagation.inject(context.active(), propagated, { set(carrier, key, value) {
              if (key.toLowerCase() === "traceparent") carrier.traceparent = value;
            } });
          } catch {
            // Telemetry context is optional. Delivery proceeds without it.
          }
          try {
            invoked = true;
            completed = await fn(propagated);
            succeeded = true;
            try { uploads.add(1, metricAttrs); } catch { /* telemetry is fail-open */ }
            return completed;
          } catch (error) {
            try {
              span.setStatus({ code: SpanStatusCode.ERROR });
              span.setAttribute("error.type", error instanceof Error ? error.name : "UnknownError");
            } catch { /* telemetry is fail-open */ }
            throw error;
          } finally {
            try { duration.record(performance.now() - started, metricAttrs); } catch { /* telemetry is fail-open */ }
            try { uploadBytes.record(Number(attrs["augenta.bytes"] ?? 0), metricAttrs); } catch { /* telemetry is fail-open */ }
            try { span.end(); } catch { /* telemetry is fail-open */ }
          }
        });
      } catch (error) {
        if (succeeded) return completed as T;
        if (!invoked) return fn({});
        throw error;
      }
    },
    recordDrain(attributes) {
      const attrs = safePluginAttributes(attributes);
      const metricAttrs = lowCardinalityMetricAttributes(attrs);
      try {
        drains.add(1, metricAttrs);
        shipped.add(Number(attributes["augenta.count"] ?? 0), metricAttrs);
        outbox.record(Number(attributes["augenta.bytes"] ?? 0), metricAttrs);
        if (attributes["augenta.reason"] !== "success") failures.add(1, metricAttrs);
      } catch { /* telemetry is fail-open */ }
    },
    recordRetry(attributes) { try { retries.add(1, lowCardinalityMetricAttributes(attributes)); } catch { /* fail-open */ } },
    event(name, attributes) {
      try { logger.emit({ eventName: name, severityText: "INFO",
        attributes: safePluginAttributes({ ...attributes, "operation.name": name }) }); } catch { /* fail-open */ }
    },
    async flush(timeoutMillis = 1_000) {
      const work = Promise.allSettled([
        traceProvider.forceFlush(), metricProvider.forceFlush(), logProvider.forceFlush(),
      ]).then(() => Promise.allSettled([
        traceProvider.shutdown(), metricProvider.shutdown(), logProvider.shutdown(),
      ])).then(() => undefined);
      await Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, timeoutMillis))]);
    },
  };
}
