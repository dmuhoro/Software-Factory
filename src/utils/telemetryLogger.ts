/**
 * Telemetry and Structured Tracing Logger
 * Outputs strict, structured JSON log events for cloud ingestion (Fluentbit, Datadog, CloudWatch).
 */

export interface LogPayload {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  service: string;
  tenantId?: string;
  niche?: string;
  correlationId?: string;
  eventType?: string;
  message: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export class TelemetryLogger {
  private static serviceName = 'software-factory-runtime';

  public static info(message: string, context?: Partial<LogPayload>): void {
    this.emit('INFO', message, context);
  }

  public static warn(message: string, context?: Partial<LogPayload>): void {
    this.emit('WARN', message, context);
  }

  public static error(message: string, context?: Partial<LogPayload>): void {
    this.emit('ERROR', message, context);
  }

  public static debug(message: string, context?: Partial<LogPayload>): void {
    this.emit('DEBUG', message, context);
  }

  private static emit(level: LogPayload['level'], message: string, context?: Partial<LogPayload>): void {
    const logObj: LogPayload = {
      timestamp: new Date().toISOString(),
      level,
      service: this.serviceName,
      message,
      tenantId: context?.tenantId,
      niche: context?.niche,
      correlationId: context?.correlationId,
      eventType: context?.eventType,
      durationMs: context?.durationMs,
      metadata: context?.metadata,
    };

    // Output strictly formatted JSON line for cloud runners
    const output = JSON.stringify(logObj);
    if (level === 'ERROR') {
      console.error(output);
    } else if (level === 'WARN') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }
}
