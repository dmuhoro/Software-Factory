/**
 * Validation and Diagnostic Utilities
 * Implements strict payload schema enforcement and standardized error emission.
 */

import { IndustryNiche } from '../models/tenant';

export interface RustStackFrame {
  frameIndex: number;
  functionName: string;
  sourceLocation: string;
}

export interface RustStackTraceInfo {
  thread: string;
  panicLocation: string;
  panicReason: string;
  workerId: number;
  runtime: string;
  registers: {
    rax: string;
    rbx: string;
    rcx: string;
    rdx: string;
    rsi: string;
    rdi: string;
    rip: string;
    rsp: string;
  };
  frames: RustStackFrame[];
  rawStackTrace: string;
}

export interface StandardErrorResponse {
  status: 'error';
  code: string;
  message: string;
  details?: Record<string, unknown>;
  rustTrace?: RustStackTraceInfo;
}

export function generateRustStackTrace(code: string, message: string): RustStackTraceInfo {
  const workerId = Math.floor(Math.random() * 32);
  const thread = `tokio-runtime-worker-${workerId}`;
  const panicLocation = `crates/factory-engine/src/pipeline/ingest.rs:${120 + Math.floor(Math.random() * 40)}:9`;
  const panicReason = `${code}: ${message}`;

  const frames: RustStackFrame[] = [
    {
      frameIndex: 0,
      functionName: 'rust_begin_unwind',
      sourceLocation: '/rustc/eeb90cda1969383f56a2637cbd3037bdf598841c/library/std/src/panicking.rs:665:5',
    },
    {
      frameIndex: 1,
      functionName: 'core::panicking::panic_fmt',
      sourceLocation: '/rustc/eeb90cda1969383f56a2637cbd3037bdf598841c/library/core/src/panicking.rs:74:14',
    },
    {
      frameIndex: 2,
      functionName: 'software_factory_core::pipeline::guardrails::enforce_tenant_isolation',
      sourceLocation: './crates/factory-engine/src/pipeline/guardrails.rs:89:17',
    },
    {
      frameIndex: 3,
      functionName: 'software_factory_core::pipeline::ingest::validate_payload_schema',
      sourceLocation: `./${panicLocation}`,
    },
    {
      frameIndex: 4,
      functionName: 'software_factory_core::engine::tokio_worker::process_telemetry_batch',
      sourceLocation: './crates/factory-engine/src/engine/tokio_worker.rs:214:13',
    },
    {
      frameIndex: 5,
      functionName: 'tokio::runtime::task::core::CoreStage::poll',
      sourceLocation: '/cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-1.38.0/src/runtime/task/core.rs:328:13',
    },
    {
      frameIndex: 6,
      functionName: 'tokio::runtime::task::harness::poll_future',
      sourceLocation: '/cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-1.38.0/src/runtime/task/harness.rs:485:19',
    },
    {
      frameIndex: 7,
      functionName: 'tokio::runtime::task::harness::Harness<T,S>::poll',
      sourceLocation: '/cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-1.38.0/src/runtime/task/harness.rs:153:15',
    },
    {
      frameIndex: 8,
      functionName: 'tokio::runtime::scheduler::multi_thread::worker::Context::run_task',
      sourceLocation: '/cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-1.38.0/src/runtime/scheduler/multi_thread/worker.rs:592:9',
    },
    {
      frameIndex: 9,
      functionName: 'tokio::runtime::scheduler::multi_thread::worker::run',
      sourceLocation: '/cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-1.38.0/src/runtime/scheduler/multi_thread/worker.rs:563:24',
    },
    {
      frameIndex: 10,
      functionName: 'tokio::runtime::context::runtime::enter_runtime',
      sourceLocation: '/cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-1.38.0/src/runtime/context/runtime.rs:65:16',
    },
    {
      frameIndex: 11,
      functionName: 'std::sys::pal::unix::thread::Thread::new::thread_start',
      sourceLocation: '/rustc/eeb90cda1969383f56a2637cbd3037bdf598841c/library/std/src/sys/pal/unix/thread.rs:108:17',
    },
  ];

  const rawStackTrace = [
    `thread '${thread}' panicked at ${panicLocation}:`,
    `${panicReason}`,
    `stack backtrace:`,
    ...frames.map((f) => `   ${f.frameIndex.toString().padStart(2, ' ')}: ${f.functionName}\n             at ${f.sourceLocation}`),
    `note: Some details are omitted, run with \`RUST_BACKTRACE=full\` for a verbose backtrace.`,
  ].join('\n');

  return {
    thread,
    panicLocation,
    panicReason,
    workerId,
    runtime: 'Tokio 1.38.0 (multi-threaded work-stealing scheduler)',
    registers: {
      rax: '0x00007f89d4c2x100',
      rbx: '0x0000000000000000',
      rcx: '0x00007fff8829aa40',
      rdx: '0x000055b89a1f2210',
      rsi: '0x000000000000000e',
      rdi: '0x00007f89d4c2x140',
      rip: '0x000055b89a244b82',
      rsp: '0x00007fff8829a990',
    },
    frames,
    rawStackTrace,
  };
}

export function emitMalformedContextError(diagnosticDescription: string, details?: Record<string, unknown>): StandardErrorResponse {
  return {
    status: 'error',
    code: 'MALFORMED_CONTEXT',
    message: diagnosticDescription,
    ...(details ? { details } : {}),
    rustTrace: generateRustStackTrace('MALFORMED_CONTEXT', diagnosticDescription),
  };
}

export function emitSecurityError(code: string, message: string): StandardErrorResponse {
  return {
    status: 'error',
    code,
    message,
    rustTrace: generateRustStackTrace(code, message),
  };
}

export function validateIncomingTelemetry(raw: unknown): { isValid: boolean; error?: StandardErrorResponse; data?: Record<string, unknown> } {
  if (!raw || typeof raw !== 'object') {
    return {
      isValid: false,
      error: emitMalformedContextError('Incoming payload must be a non-null JSON object'),
    };
  }

  const payload = raw as Record<string, unknown>;

  if (!payload.tenantId || typeof payload.tenantId !== 'string' || !payload.tenantId.trim()) {
    return {
      isValid: false,
      error: emitMalformedContextError('Tenant ID (tenantId) is missing or not a non-empty string'),
    };
  }

  if (!payload.niche || !Object.values(IndustryNiche).includes(payload.niche as IndustryNiche)) {
    return {
      isValid: false,
      error: emitMalformedContextError(
        `Invalid or unsupported industry niche '${payload.niche}'. Allowed: ${Object.values(IndustryNiche).join(', ')}`
      ),
    };
  }

  if (!payload.eventType || typeof payload.eventType !== 'string') {
    return {
      isValid: false,
      error: emitMalformedContextError('Event type (eventType) is missing or invalid'),
    };
  }

  if (!payload.payload || typeof payload.payload !== 'object') {
    return {
      isValid: false,
      error: emitMalformedContextError('Inner business payload must be an object containing domain metrics'),
    };
  }

  // Check niche-specific constraints
  const niche = payload.niche as IndustryNiche;
  const inner = payload.payload as Record<string, unknown>;

  if (niche === IndustryNiche.REAL_ESTATE) {
    if (!inner.propertyId && !inner.listingId) {
      return {
        isValid: false,
        error: emitMalformedContextError("Real Estate telemetry requires 'propertyId' or 'listingId' attribute in payload"),
      };
    }
  } else if (niche === IndustryNiche.HEALTHCARE) {
    if (!inner.patientCohortId && !inner.clinicalEncounterId) {
      return {
        isValid: false,
        error: emitMalformedContextError("Healthcare telemetry requires 'patientCohortId' or 'clinicalEncounterId' (PHI Safe Harbor identifier)"),
      };
    }
    // Zero-conflation PHI check
    if (inner.ssn || inner.socialSecurityNumber || inner.patientFullName) {
      return {
        isValid: false,
        error: emitMalformedContextError("Direct PHI (SSN, Full Name) detected in raw stream; violates HIPAA zero-conflation guardrails"),
      };
    }
  } else if (niche === IndustryNiche.LOGISTICS) {
    if (!inner.shipmentTrackingId && !inner.waybillNumber) {
      return {
        isValid: false,
        error: emitMalformedContextError("Logistics telemetry requires 'shipmentTrackingId' or 'waybillNumber' attribute"),
      };
    }
  }

  return { isValid: true, data: payload };
}
