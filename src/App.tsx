/**
 * Software Factory - Enterprise Multi-Tenant Mission Control
 * Real-time monitoring, telemetry stream testing, Recharts metrics, and Appwrite partition governance.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Building2,
  Activity,
  Truck,
  ShieldCheck,
  Cpu,
  Database,
  Terminal,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Play,
  FileText,
  Server,
  Boxes,
  Lock,
  Download,
  Check,
  Sparkles,
  Layers,
  Bug,
  Copy,
  Radio,
  GitCompare,
  Printer,
} from 'lucide-react';
import { IndustryNiche } from './models/tenant';
import { ALL_COLLECTION_BLUEPRINTS, APPWRITE_DATABASE_CONFIG } from './models/appwriteSchema';
import { TelemetryExecutionLog, SystemHealthStats, TenantConfigFlags, AutoRefreshInterval } from './types';
import { HealthDashboard } from './components/HealthDashboard';
import { RecentExecutionsSidebar } from './components/RecentExecutionsSidebar';
import { TenantSettingsToggle } from './components/TenantSettingsToggle';
import { LoopControlPanel } from './components/LoopControlPanel';
import { ComparePayloadsModal } from './components/ComparePayloadsModal';
import { downloadTenantAuditReport } from './utils/reportGenerator';

interface TelemetryResult {
  status: string;
  correlationId: string;
  tenantId: string;
  niche: string;
  transformationId?: string;
  durationMs: number;
  structuredOutput?: any;
  audit?: any;
  error?: any;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'stream' | 'appwrite' | 'gemini' | 'governance' | 'loop'>('stream');
  const [selectedTenant, setSelectedTenant] = useState<string>('tenant_re_8841');
  const [selectedNiche, setSelectedNiche] = useState<IndustryNiche>(IndustryNiche.REAL_ESTATE);
  const [eventType, setEventType] = useState<string>('PROPERTY_VALUATION_REQUEST');
  const [payloadText, setPayloadText] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [executionResult, setExecutionResult] = useState<TelemetryResult | null>(null);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);

  // Compare Payloads & Configuration Drift State
  const [showCompareModal, setShowCompareModal] = useState<boolean>(false);
  const [lastSuccessfulPayload, setLastSuccessfulPayload] = useState<Record<string, any> | null>(null);

  // Detailed Trace & Observability State
  const [showDetailedTrace, setShowDetailedTrace] = useState<boolean>(false);
  const [copiedTrace, setCopiedTrace] = useState<boolean>(false);

  // Auto-Refresh Interval Configuration State ('manual' | '5s' | '30s')
  const [refreshInterval, setRefreshInterval] = useState<AutoRefreshInterval>('5s');
  const [lastUpdatedTime, setLastUpdatedTime] = useState<string>('');

  // Real-time Health and Metrics State
  const [healthData, setHealthData] = useState<SystemHealthStats | null>(null);
  // The deployed artifact's own version, read from the server's health payload. Never a
  // hardcoded label: the whole point is that a live URL states which build it is serving.
  const [appVersion, setAppVersion] = useState<string>('unknown');
  const [healthLoading, setHealthLoading] = useState<boolean>(false);

  // Execution History Logs
  const [executionLogs, setExecutionLogs] = useState<TelemetryExecutionLog[]>([]);

  // Tenant Config Flags State
  const [tenantConfigs, setTenantConfigs] = useState<Record<string, TenantConfigFlags>>({
    tenant_re_8841: {
      tenantId: 'tenant_re_8841',
      fairHousingGuardrails: true,
      hipaaStrictRedaction: false,
      coldchainTempAlerting: false,
      autoDbSync: true,
      auditLedgerMirroring: true,
      isActive: true,
    },
    tenant_hc_1042: {
      tenantId: 'tenant_hc_1042',
      fairHousingGuardrails: false,
      hipaaStrictRedaction: true,
      coldchainTempAlerting: false,
      autoDbSync: true,
      auditLedgerMirroring: true,
      isActive: true,
    },
    tenant_log_5529: {
      tenantId: 'tenant_log_5529',
      fairHousingGuardrails: false,
      hipaaStrictRedaction: false,
      coldchainTempAlerting: true,
      autoDbSync: true,
      auditLedgerMirroring: true,
      isActive: true,
    },
  });

  // Preset sample payloads for fast demonstration
  const samplePayloads: Record<IndustryNiche, { eventType: string; payload: any }> = useMemo(() => ({
    [IndustryNiche.REAL_ESTATE]: {
      eventType: 'PROPERTY_VALUATION_REQUEST',
      payload: {
        propertyId: 'PROP-PALM-4920',
        listPrice: 850000,
        squareFootage: 2950,
        propertyType: 'Single Family Residence',
        zipCode: '90210',
        hoaDuesMonthly: 250,
      },
    },
    [IndustryNiche.HEALTHCARE]: {
      eventType: 'PATIENT_INTAKE_TRIAGE',
      payload: {
        patientCohortId: 'COHORT-ER-8812',
        heartRate: 118,
        systolicBloodPressure: 154,
        diastolicBloodPressure: 96,
        oxygenSaturationPercent: 95,
        reportedPainScale: 8,
        chiefComplaint: 'Acute substernal tightness and localized dyspnea',
      },
    },
    [IndustryNiche.LOGISTICS]: {
      eventType: 'REEFER_COLDCHAIN_TELEMETRY',
      payload: {
        shipmentTrackingId: 'SHIP-REEFER-7740',
        cargoTemperatureCelsius: 9.4,
        minAllowedTempCelsius: 2.0,
        maxAllowedTempCelsius: 8.0,
        ambientOutsideTempCelsius: 32.5,
        transportMode: 'Refrigerated Intermodal Container',
        currentGpsCoordinates: '34.0522° N, 118.2437° W',
      },
    },
    [IndustryNiche.CUSTOM_B2B]: {
      eventType: 'ENTERPRISE_TRANSACTION_AUDIT',
      payload: {
        entityId: 'CORP-TX-9901',
        transactionVolumeUsd: 450000,
        settlementChannel: 'Automated Clearing House',
        riskFlag: 'ELEVATED',
      },
    },
  }), []);

  // Real-time JSON validation of the textarea
  const jsonValidation = useMemo(() => {
    if (!payloadText.trim()) {
      return { isValid: false, message: 'Payload is empty' };
    }
    try {
      JSON.parse(payloadText);
      return { isValid: true, message: 'Valid JSON format' };
    } catch (err: any) {
      return { isValid: false, message: err.message || 'Syntax Error' };
    }
  }, [payloadText]);

  // Switch niche & tenant presets
  const handleNicheSwitch = useCallback((niche: IndustryNiche) => {
    setSelectedNiche(niche);
    let newTenant = 'tenant_re_8841';
    if (niche === IndustryNiche.HEALTHCARE) newTenant = 'tenant_hc_1042';
    if (niche === IndustryNiche.LOGISTICS) newTenant = 'tenant_log_5529';
    if (niche === IndustryNiche.CUSTOM_B2B) newTenant = 'tenant_re_8841';
    setSelectedTenant(newTenant);

    const preset = samplePayloads[niche];
    setEventType(preset.eventType);
    setPayloadText(JSON.stringify(preset.payload, null, 2));
  }, [samplePayloads]);

  // Fetch Health & Metrics from API
  const fetchHealthAndMetrics = useCallback(async () => {
    setHealthLoading(true);
    try {
      const hRes = await fetch('/api/factory/health');

      if (hRes.ok) {
        const hJson = await hRes.json();
        setLastUpdatedTime(new Date().toLocaleTimeString());
        if (typeof hJson.version === 'string') setAppVersion(hJson.version);
        if (hJson.systemHealth) {
          setHealthData({
            status: hJson.status,
            name: hJson.name ?? 'unknown',
            version: hJson.version ?? 'unknown',
            heapUsedMb: hJson.systemHealth.memory.heapUsedMb,
            heapTotalMb: hJson.systemHealth.memory.heapTotalMb,
            rssMb: hJson.systemHealth.memory.rssMb,
            memoryPressureScore: hJson.systemHealth.memory.memoryPressureScore,
            uptimeSeconds: hJson.uptimeSeconds ?? 0,
            checks: hJson.checks ?? {},
            checkDetails: hJson.checkDetails ?? [],
            recovery: hJson.recovery ?? null,
            lastUpdated: new Date().toLocaleTimeString(),
          });
        }
      }
    } catch {
      // offline or startup
    } finally {
      setHealthLoading(false);
    }
  }, []);
  useEffect(() => {
    handleNicheSwitch(IndustryNiche.REAL_ESTATE);
  }, [handleNicheSwitch]);

  // User-configurable auto-refresh interval for Telemetry Stream and Health Metrics
  useEffect(() => {
    fetchHealthAndMetrics();

    if (refreshInterval === 'manual') {
      return;
    }

    const intervalMs = refreshInterval === '5s' ? 5000 : 30000;
    const interval = setInterval(fetchHealthAndMetrics, intervalMs);
    return () => clearInterval(interval);
  }, [refreshInterval, fetchHealthAndMetrics]);

  // Dispatch Telemetry Ingest Request
  const dispatchTelemetry = async (forceMalformed = false, forceConflation = false) => {
    setLoading(true);
    setSelectedLogId(null);

    const startTime = Date.now();
    let currentPayload = {};

    try {
      currentPayload = JSON.parse(payloadText);
    } catch (parseErr: any) {
      const errorMsg = `Interactive JSON input parse failure: ${parseErr.message}`;
      const errorObj = {
        status: 'error',
        code: 'MALFORMED_CONTEXT',
        message: errorMsg,
      };
      setExecutionResult({
        status: 'error',
        correlationId: `corr_err_${Date.now()}`,
        tenantId: selectedTenant,
        niche: selectedNiche,
        durationMs: 1,
        error: errorObj,
      });

      // Record in logs
      addLogEntry({
        status: 'error',
        correlationId: `corr_err_${Date.now()}`,
        tenantId: selectedTenant,
        niche: selectedNiche,
        eventType,
        durationMs: 1,
        error: errorObj,
        payloadSnapshot: payloadText,
      });

      setLoading(false);
      return;
    }

    const tenantTarget = forceConflation ? 'tenant_hc_1042' : selectedTenant;

    const body: any = {
      tenantId: tenantTarget,
      niche: selectedNiche,
      eventType: eventType,
      metadata: {
        sourceSystem: 'MissionControl-WebClient',
        region: 'europe-west2',
        clientVersion: '3.2.0',
        idempotencyKey: `idem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      },
      payload: forceMalformed ? { corruptedPayloadKey: null, missingRequiredFields: true } : currentPayload,
    };

    try {
      const res = await fetch('/api/telemetry/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': body.tenantId,
          'X-Industry-Niche': body.niche,
        },
        body: JSON.stringify(body),
      });

      const json = await res.json();
      const elapsed = Date.now() - startTime;

      if (!res.ok) {
        const errorResult = {
          status: 'error',
          correlationId: json.correlationId || `corr_err_${Date.now()}`,
          tenantId: body.tenantId,
          niche: body.niche,
          durationMs: elapsed,
          error: json,
        };
        setExecutionResult(errorResult);
        addLogEntry({
          status: 'error',
          correlationId: errorResult.correlationId,
          tenantId: body.tenantId,
          niche: body.niche,
          eventType,
          durationMs: elapsed,
          error: json,
          payloadSnapshot: body.payload,
        });
      } else {
        setExecutionResult(json);
        setLastSuccessfulPayload(body.payload);
        addLogEntry({
          status: 'success',
          correlationId: json.correlationId,
          tenantId: body.tenantId,
          niche: body.niche,
          eventType,
          durationMs: json.durationMs || elapsed,
          confidenceScore: json.structuredOutput?.confidenceScore,
          tokensConsumed: json.audit?.tokens || 0,
          structuredOutput: json.structuredOutput,
          payloadSnapshot: body.payload,
        });
      }
    } catch (err: any) {
      const errorMsg = err.message || 'Failed to reach API gateway endpoint';
      const errorResult = {
        status: 'error',
        correlationId: `corr_net_${Date.now()}`,
        tenantId: selectedTenant,
        niche: selectedNiche,
        durationMs: Date.now() - startTime,
        error: {
          status: 'error',
          code: 'NETWORK_PIPELINE_ERROR',
          message: errorMsg,
        },
      };
      setExecutionResult(errorResult);
      addLogEntry({
        status: 'error',
        correlationId: errorResult.correlationId,
        tenantId: selectedTenant,
        niche: selectedNiche,
        eventType,
        durationMs: errorResult.durationMs,
        error: errorResult.error,
        payloadSnapshot: body.payload,
      });
    } finally {
      setLoading(false);
      fetchHealthAndMetrics();
    }
  };

  const addLogEntry = (entry: Omit<TelemetryExecutionLog, 'id' | 'timestamp'>) => {
    const newLog: TelemetryExecutionLog = {
      ...entry,
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
    };
    setExecutionLogs((prev) => [newLog, ...prev.slice(0, 49)]); // Keep last 50
  };

  const handleSelectHistoricalLog = (log: TelemetryExecutionLog) => {
    setSelectedLogId(log.id);
    setExecutionResult({
      status: log.status,
      correlationId: log.correlationId,
      tenantId: log.tenantId,
      niche: log.niche,
      durationMs: log.durationMs,
      structuredOutput: log.structuredOutput,
      audit: {
        tokens: log.tokensConsumed,
        model: 'gemini-1.5-pro',
      },
      error: log.error,
    });
  };

  // Export current structured output as JSON file
  const handleDownloadAuditJson = () => {
    if (!executionResult) return;
    const exportData = {
      exportMetadata: {
        exportedAt: new Date().toISOString(),
        system: 'Software Factory Multi-Tenant B2B Platform v3.2.0',
        auditStandard: 'SOC2-TypeII-HIPAA-ISO27001',
      },
      executionRecord: executionResult,
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit-trail-${executionResult.correlationId || 'record'}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Export full execution ledger
  const handleExportFullLedger = () => {
    if (executionLogs.length === 0) return;
    const ledger = {
      exportTimestamp: new Date().toISOString(),
      totalRecords: executionLogs.length,
      platform: 'Software Factory Runtime Engine',
      records: executionLogs,
    };

    const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `software-factory-ledger-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Generate and download PDF-style structured summary report for selected tenant
  const handleDownloadTenantPdfReport = () => {
    downloadTenantAuditReport({
      tenantId: selectedTenant,
      niche: selectedNiche,
      generatedAt: new Date().toISOString(),
      config: tenantConfigs[selectedTenant],
      logs: executionLogs,
    });
  };

  // Toggle tenant configuration flag
  const handleToggleTenantFlag = (tenantId: string, flag: keyof TenantConfigFlags) => {
    setTenantConfigs((prev) => {
      const current = prev[tenantId];
      if (!current) return prev;
      return {
        ...prev,
        [tenantId]: {
          ...current,
          [flag]: !current[flag],
        },
      };
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
      {/* Top Enterprise Control Bar */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md px-6 py-4 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-sky-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Boxes className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-semibold text-lg tracking-tight text-white">SOFTWARE FACTORY</h1>
                <span
                  className="px-2 py-0.5 rounded text-[11px] font-mono font-medium bg-indigo-950 text-indigo-300 border border-indigo-800"
                  title="Version reported by the running server, read from its own package.json"
                >
                  v{appVersion}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Multi-Tenant B2B SaaS Control Plane • Node runtime • Durable ledger + Gemini Structured AI
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700/80 text-xs">
              <span className={`w-2 h-2 rounded-full ${healthData?.status === 'unhealthy' ? 'bg-rose-400' : healthData?.status === 'degraded' ? 'bg-amber-400' : 'bg-emerald-400'} animate-pulse`}></span>
              <span className="text-slate-300 font-mono">
                {healthData ? `Readiness: ${healthData.status}` : 'Readiness: connecting…'}
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700/80 text-xs">
              <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
              <span className="text-slate-300 font-mono">Zero Conflation: Enforced</span>
            </div>
            <button
              onClick={fetchHealthAndMetrics}
              disabled={healthLoading}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-white transition"
              title="Refresh Engine Telemetry"
            >
              <RefreshCw className={`w-4 h-4 ${healthLoading ? 'animate-spin text-indigo-400' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      {/* Navigation Sub-header */}
      <div className="border-b border-slate-800 bg-slate-900/40 px-6">
        <div className="max-w-7xl mx-auto flex gap-2 overflow-x-auto py-2">
          {[
            { id: 'stream', label: 'Telemetry Stream & Logs', icon: Terminal },
            { id: 'appwrite', label: 'Appwrite Multi-Tenant DB', icon: Database },
            { id: 'gemini', label: 'Gemini JSON Schemas', icon: Cpu },
            { id: 'governance', label: 'Constitution & ADRs', icon: FileText },
            { id: 'loop', label: 'Unattended Loop', icon: Play },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                  active
                    ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Workspace */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        {/* TAB 6: UNATTENDED LOOP CONTROL PLANE */}
        {activeTab === 'loop' && <LoopControlPanel />}

        {/* TAB 1: TELEMETRY STREAM & LOGS */}
        {activeTab === 'stream' && (
          <div className="space-y-6">
            {/* Runtime health - real readiness checks, memory and uptime only */}
            <HealthDashboard
              health={healthData}
              loading={healthLoading}
              onRefresh={fetchHealthAndMetrics}
              refreshInterval={refreshInterval}
              onChangeInterval={setRefreshInterval}
              lastUpdatedTime={lastUpdatedTime}
            />

            {/* Niche Selector Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                {
                  niche: IndustryNiche.REAL_ESTATE,
                  title: 'Real Estate / PropTech',
                  tenant: 'tenant_re_8841 (Apex Realty)',
                  icon: Building2,
                  standards: 'Fair Housing • RESPA',
                  accent: 'from-amber-500/10 to-orange-500/10 border-amber-500/30 text-amber-400',
                },
                {
                  niche: IndustryNiche.HEALTHCARE,
                  title: 'Healthcare / Clinical',
                  tenant: 'tenant_hc_1042 (Vanguard Health)',
                  icon: Activity,
                  standards: 'HIPAA Safe Harbor • HL7 FHIR v4',
                  accent: 'from-emerald-500/10 to-teal-500/10 border-emerald-500/30 text-emerald-400',
                },
                {
                  niche: IndustryNiche.LOGISTICS,
                  title: 'Freight / Cold-Chain',
                  tenant: 'tenant_log_5529 (TransContinental)',
                  icon: Truck,
                  standards: 'IATA Dangerous Goods • DOT ELD',
                  accent: 'from-sky-500/10 to-blue-500/10 border-sky-500/30 text-sky-400',
                },
              ].map((card) => {
                const Icon = card.icon;
                const isSelected = selectedNiche === card.niche;
                return (
                  <button
                    key={card.niche}
                    onClick={() => handleNicheSwitch(card.niche)}
                    className={`text-left p-4 rounded-xl border transition-all relative overflow-hidden ${
                      isSelected
                        ? `bg-gradient-to-br ${card.accent} border-indigo-500 ring-1 ring-indigo-500/50 shadow-lg`
                        : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Icon className="w-5 h-5 text-indigo-400" />
                        <span className="font-medium text-sm text-white">{card.title}</span>
                      </div>
                      {isSelected && <span className="w-2 h-2 rounded-full bg-indigo-400"></span>}
                    </div>
                    <p className="text-xs font-mono text-slate-400">{card.tenant}</p>
                    <div className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-400">
                      <Lock className="w-3 h-3 text-slate-400" />
                      <span>{card.standards}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* 3-Column Layout: Sidebar (Logs) + Ingestion Console + Live Output Ledger */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Left Column: API Execution Logs Sidebar (3 cols) */}
              <div className="lg:col-span-3">
                <RecentExecutionsSidebar
                  logs={executionLogs}
                  selectedId={selectedLogId}
                  onSelectLog={handleSelectHistoricalLog}
                  onExportLedger={handleExportFullLedger}
                  onExportTenantReport={handleDownloadTenantPdfReport}
                  onClearLogs={() => setExecutionLogs([])}
                />
              </div>

              {/* Middle Column: Ingestion Console (4 cols) */}
              <div className="lg:col-span-4 bg-slate-900/80 border border-slate-800 rounded-xl p-5 flex flex-col space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-indigo-400" />
                    <h2 className="text-sm font-semibold text-white">Ingestion Console</h2>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleDownloadTenantPdfReport}
                      className="px-2 py-0.5 rounded bg-indigo-950/90 hover:bg-indigo-900 border border-indigo-700/60 text-indigo-300 text-[10px] font-mono flex items-center gap-1 transition"
                      title="Download PDF-style structured compliance and performance audit summary report for selected tenant"
                    >
                      <FileText className="w-3 h-3 text-indigo-400" />
                      <span>PDF Report</span>
                    </button>
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                      {selectedTenant}
                    </span>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">Event Type Identifier</label>
                  <input
                    type="text"
                    value={eventType}
                    onChange={(e) => setEventType(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                {/* Real-Time JSON Schema Validator Badge & Compare Drift Action */}
                <div className="flex-1 flex flex-col">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs text-slate-400">Business Telemetry JSON</label>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setShowCompareModal(true)}
                        className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-950/80 hover:bg-indigo-900 text-indigo-300 border border-indigo-800 flex items-center gap-1 transition shadow-sm"
                        title="Compare current payload against last successful request to detect configuration drift"
                      >
                        <GitCompare className="w-3 h-3 text-indigo-400" />
                        <span>Compare Payloads</span>
                      </button>

                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1 border ${
                          jsonValidation.isValid
                            ? 'bg-emerald-950/70 text-emerald-300 border-emerald-800'
                            : 'bg-red-950/70 text-red-300 border-red-800'
                        }`}
                        title={jsonValidation.message}
                      >
                        {jsonValidation.isValid ? (
                          <>
                            <Check className="w-2.5 h-2.5 text-emerald-400" />
                            Valid
                          </>
                        ) : (
                          <>
                            <AlertTriangle className="w-2.5 h-2.5 text-red-400" />
                            Syntax Error
                          </>
                        )}
                      </span>
                      <button
                        onClick={() => handleNicheSwitch(selectedNiche)}
                        className="text-[11px] text-indigo-400 hover:text-indigo-300 underline"
                      >
                        Reset
                      </button>
                    </div>
                  </div>

                  <textarea
                    rows={11}
                    value={payloadText}
                    onChange={(e) => setPayloadText(e.target.value)}
                    className={`w-full bg-slate-950 border rounded-lg p-3 text-xs font-mono text-slate-200 focus:outline-none leading-relaxed resize-none transition-colors ${
                      jsonValidation.isValid
                        ? 'border-slate-800 focus:border-indigo-500'
                        : 'border-red-600/80 focus:border-red-500 bg-red-950/10'
                    }`}
                  />
                  {!jsonValidation.isValid && (
                    <p className="text-[10px] text-red-400 font-mono mt-1 truncate">
                      {jsonValidation.message}
                    </p>
                  )}
                </div>

                <div className="space-y-2 pt-1">
                  <button
                    onClick={() => dispatchTelemetry(false, false)}
                    disabled={loading || !jsonValidation.isValid}
                    className="w-full py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 transition disabled:opacity-50"
                  >
                    {loading ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Processing in Pipeline...</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Dispatch Telemetry Stream</span>
                      </>
                    )}
                  </button>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => dispatchTelemetry(true, false)}
                      disabled={loading}
                      className="py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-mono border border-slate-700 flex items-center justify-center gap-1.5 transition"
                      title="Tests standardized MALFORMED_CONTEXT error emission"
                    >
                      <AlertTriangle className="w-3 h-3 text-amber-400" />
                      Test Malformed Error
                    </button>
                    <button
                      onClick={() => dispatchTelemetry(false, true)}
                      disabled={loading}
                      className="py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-mono border border-slate-700 flex items-center justify-center gap-1.5 transition"
                      title="Tests zero-conflation violation rejection"
                    >
                      <Lock className="w-3 h-3 text-red-400" />
                      Test Cross-Conflation
                    </button>
                  </div>
                </div>
              </div>

              {/* Right Column: Execution Ledger & Download Button (5 cols) */}
              <div className="lg:col-span-5 bg-slate-900/80 border border-slate-800 rounded-xl p-5 flex flex-col space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-emerald-400" />
                    <h2 className="text-sm font-semibold text-white">Structured Output & Audit Ledger</h2>
                  </div>
                  <div className="flex items-center gap-2">
                    {executionResult && (
                      <button
                        onClick={() => setShowDetailedTrace(!showDetailedTrace)}
                        className={`px-2.5 py-1 rounded text-[11px] font-mono flex items-center gap-1.5 transition border ${
                          showDetailedTrace
                            ? 'bg-amber-950/90 border-amber-500 text-amber-300 shadow-sm shadow-amber-950/50'
                            : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
                        }`}
                        title="Toggle diagnostic detail for the selected execution"
                      >
                        <Bug className={`w-3.5 h-3.5 ${showDetailedTrace ? 'text-amber-400' : 'text-slate-400'}`} />
                        <span>Detailed Trace {showDetailedTrace ? 'ON' : 'OFF'}</span>
                      </button>
                    )}
                    {executionResult && (
                      <button
                        onClick={handleDownloadAuditJson}
                        className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-indigo-300 text-[11px] font-mono flex items-center gap-1 transition"
                        title="Download structured output as local JSON file"
                      >
                        <Download className="w-3 h-3 text-indigo-400" />
                        <span>Download Audit JSON</span>
                      </button>
                    )}
                    {executionResult && (
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                          executionResult.status === 'success'
                            ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800'
                            : 'bg-red-950/60 text-red-400 border-red-800'
                        }`}
                      >
                        {executionResult.status.toUpperCase()} ({executionResult.durationMs}ms)
                      </span>
                    )}
                  </div>
                </div>

                {!executionResult && !loading && (
                  <div className="flex-1 min-h-[340px] rounded-lg border border-dashed border-slate-800 flex flex-col items-center justify-center p-8 text-center text-slate-500 space-y-3">
                    <Terminal className="w-8 h-8 text-slate-600" />
                    <div>
                      <p className="text-sm font-medium text-slate-400">Stream Waiting for Ingestion</p>
                      <p className="text-xs text-slate-500 max-w-sm mt-1">
                        Dispatch a telemetry payload or select an item from the API Execution Logs sidebar to inspect the structured result.
                      </p>
                    </div>
                  </div>
                )}

                {loading && (
                  <div className="flex-1 min-h-[340px] rounded-lg border border-slate-800 bg-slate-950/40 flex flex-col items-center justify-center p-8 text-center space-y-3">
                    <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin" />
                    <p className="text-xs font-mono text-slate-400">
                      Executing: Ingest → Partition Guard → Domain Adapter → Gemini Structured Engine → Appwrite Async Update
                    </p>
                  </div>
                )}

                {executionResult && (
                  <div className="space-y-4 flex-1 overflow-y-auto max-h-[580px] pr-1">
                    {/* Execution Meta Cards */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                      <div className="bg-slate-950 border border-slate-800 p-2 rounded-lg">
                        <span className="text-[10px] text-slate-500 uppercase block">Correlation ID</span>
                        <span className="font-mono text-slate-300 text-[11px] truncate block">
                          {executionResult.correlationId}
                        </span>
                      </div>
                      <div className="bg-slate-950 border border-slate-800 p-2 rounded-lg">
                        <span className="text-[10px] text-slate-500 uppercase block">Appwrite DB Record</span>
                        <span className="font-mono text-indigo-300 text-[11px] truncate block">
                          {executionResult.transformationId || executionResult.audit?.rawDocumentId || 'N/A'}
                        </span>
                      </div>
                      <div className="bg-slate-950 border border-slate-800 p-2 rounded-lg">
                        <span className="text-[10px] text-slate-500 uppercase block">Tokens</span>
                        <span className="font-mono text-slate-300 text-[11px]">
                          {executionResult.audit?.tokens || 0}
                        </span>
                      </div>
                      <div className="bg-slate-950 border border-slate-800 p-2 rounded-lg">
                        <span className="text-[10px] text-slate-500 uppercase block">Latency</span>
                        <span className="font-mono text-emerald-400 text-[11px]">
                          {executionResult.durationMs} ms
                        </span>
                      </div>
                    </div>

                    {/* Result View */}
                    {executionResult.status === 'success' ? (
                      <div className="space-y-3">
                        <div className="bg-slate-950 border border-slate-800 rounded-lg p-3.5">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                              Deterministic Structured AI Transformation
                            </span>
                            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">
                              Confidence: {Math.round((executionResult.structuredOutput?.confidenceScore || 0.95) * 100)}%
                            </span>
                          </div>

                          <pre className="text-[11px] font-mono text-slate-300 bg-slate-900/90 p-3 rounded border border-slate-800 overflow-x-auto leading-relaxed">
                            {JSON.stringify(executionResult.structuredOutput, null, 2)}
                          </pre>
                        </div>

                        {/* Guardrails Applied */}
                        <div className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-3">
                          <span className="text-[11px] font-semibold text-slate-400 block mb-2">
                            Domain Guardrails & Compliance Enforced:
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {executionResult.audit?.guardrailsApplied?.map((g: string, i: number) => (
                              <span
                                key={i}
                                className="text-[11px] font-mono px-2.5 py-1 rounded bg-slate-900 text-slate-300 border border-slate-700/80 flex items-center gap-1.5"
                              >
                                <ShieldCheck className="w-3 h-3 text-indigo-400" />
                                {g}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-4 space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 text-red-400 font-semibold text-xs">
                              <AlertTriangle className="w-4 h-4" />
                              <span>Standardized Error Envelope Emitted</span>
                            </div>
                            <button
                              onClick={() => setShowDetailedTrace(!showDetailedTrace)}
                              className="text-[11px] font-mono text-amber-400 hover:text-amber-300 flex items-center gap-1 underline transition"
                            >
                              <Bug className="w-3 h-3" />
                              <span>{showDetailedTrace ? 'Hide error details' : 'Inspect error details'}</span>
                            </button>
                          </div>
                          <pre className="text-xs font-mono text-red-300 bg-red-950/60 p-3 rounded border border-red-900 overflow-x-auto">
                            {JSON.stringify(executionResult.error, null, 2)}
                          </pre>
                          <p className="text-[11px] text-slate-400">
                            Notice: Malformed metrics, incomplete properties, or cross-tenant conflations emit pure deterministic JSON without silent failures.
                          </p>
                        </div>

                        {/* ERROR DETAILS VIEW: the real envelope the server returned. */}
                        {showDetailedTrace && (
                          <div className="bg-slate-950 border border-amber-900/70 rounded-lg p-4 space-y-3 shadow-lg shadow-black/50">
                            <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                              <div className="flex items-center gap-2">
                                <Terminal className="w-4 h-4 text-amber-400" />
                                <span className="text-xs font-semibold text-amber-300 font-mono">
                                  Error Details
                                </span>
                                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-950/80 text-amber-400 border border-amber-800">
                                  server envelope
                                </span>
                              </div>
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(JSON.stringify(executionResult.error, null, 2));
                                  setCopiedTrace(true);
                                  setTimeout(() => setCopiedTrace(false), 2000);
                                }}
                                className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 text-[10px] font-mono flex items-center gap-1 transition"
                                title="Copy the error envelope to clipboard"
                              >
                                {copiedTrace ? (
                                  <>
                                    <Check className="w-3 h-3 text-emerald-400" />
                                    <span className="text-emerald-400">Copied!</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3 h-3 text-slate-400" />
                                    <span>Copy</span>
                                  </>
                                )}
                              </button>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] font-mono">
                              <div className="bg-slate-900/90 p-2.5 rounded border border-slate-800">
                                <span className="text-[10px] text-slate-500 uppercase block font-sans">Error Code</span>
                                <span className="text-red-300 font-semibold truncate block">
                                  {executionResult.error?.code || 'UNKNOWN'}
                                </span>
                              </div>
                              <div className="bg-slate-900/90 p-2.5 rounded border border-slate-800">
                                <span className="text-[10px] text-slate-500 uppercase block font-sans">Correlation ID</span>
                                <span className="text-slate-300 truncate block">
                                  {executionResult.correlationId || 'N/A'}
                                </span>
                              </div>
                              <div className="bg-slate-900/90 p-2.5 rounded border border-slate-800">
                                <span className="text-[10px] text-slate-500 uppercase block font-sans">Tenant</span>
                                <span className="text-slate-300 truncate block">
                                  {executionResult.tenantId || 'N/A'}
                                </span>
                              </div>
                            </div>

                            <div>
                              <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider block mb-1">
                                Message:
                              </span>
                              <pre className="text-[11px] font-mono text-amber-200/90 bg-slate-900/90 p-3.5 rounded-lg border border-amber-950/80 overflow-x-auto leading-relaxed whitespace-pre-wrap max-h-56">
                                {executionResult.error?.message || 'No message provided'}
                              </pre>
                            </div>

                            <p className="text-[11px] text-slate-500">
                              This process is the Node control plane. Errors are returned as deterministic JSON; no stack trace is synthesized.
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Execution trace for a successful ingest. */}
                    {showDetailedTrace && executionResult.status === 'success' && (
                      <div className="bg-slate-950 border border-indigo-900/60 rounded-lg p-3.5 space-y-2">
                        <div className="flex items-center justify-between text-xs text-indigo-300 font-mono">
                          <span className="flex items-center gap-1.5 font-semibold">
                            <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                            Execution Trace
                          </span>
                          <span className="text-[10px] text-emerald-400">status: success</span>
                        </div>
                        <pre className="text-[11px] font-mono text-slate-300 bg-slate-900/90 p-3 rounded border border-slate-800 overflow-x-auto">
{`correlationId: ${executionResult.correlationId}
tenant: ${executionResult.tenantId} (${executionResult.niche})
appwrite record: ${executionResult.transformationId || executionResult.audit?.rawDocumentId || 'N/A'}
guardrails applied: [${executionResult.audit?.guardrailsApplied?.join(', ') || 'none reported'}]
structured inference latency: ${executionResult.durationMs}ms`}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: APPWRITE MULTI-TENANT DB & PARTITION TOGGLES */}
        {activeTab === 'appwrite' && (
          <div className="space-y-6">
            {/* Interactive Tenant Configuration & Partition Rules Toggle Component */}
            <TenantSettingsToggle
              configs={tenantConfigs}
              selectedTenantId={selectedTenant}
              onSelectTenant={setSelectedTenant}
              onToggleFlag={handleToggleTenantFlag}
            />

            {/* Database Blueprint Header */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-base font-semibold text-white">Appwrite Multi-Tenant Database Architecture</h2>
                  <p className="text-xs text-slate-400">
                    Database ID: <span className="font-mono text-indigo-400">{APPWRITE_DATABASE_CONFIG.databaseId}</span> • Attribute-Level Partitioning & Team Security Matrix
                  </p>
                </div>
                <span className="text-xs font-mono px-3 py-1 rounded bg-indigo-950 text-indigo-300 border border-indigo-800">
                  Document Security: ENABLED
                </span>
              </div>

              {/* Collections Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
                {ALL_COLLECTION_BLUEPRINTS.map((col) => (
                  <div key={col.collectionId} className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
                      <div>
                        <h3 className="text-xs font-semibold text-white font-mono">{col.collectionId}</h3>
                        <p className="text-[11px] text-slate-400">{col.name}</p>
                      </div>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-800">
                        {col.attributes.length} attrs
                      </span>
                    </div>

                    <div>
                      <span className="text-[10px] text-slate-500 uppercase font-semibold block mb-1">
                        Attribute Permissions
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {col.defaultPermissions.map((perm, idx) => (
                          <span
                            key={idx}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-950/60 text-indigo-300 border border-indigo-900"
                          >
                            {perm}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div>
                      <span className="text-[10px] text-slate-500 uppercase font-semibold block mb-1">
                        Composite Indexes
                      </span>
                      <div className="space-y-1">
                        {col.indexes.map((idx, i) => (
                          <div key={i} className="text-[10px] font-mono text-slate-400 flex items-center justify-between bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                            <span className="text-slate-300 truncate max-w-[120px]">{idx.key}</span>
                            <span className="text-indigo-400">[{idx.attributes.join(', ')}]</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <p className="text-[11px] text-slate-400 italic bg-slate-900/50 p-2 rounded border border-slate-800/60">
                      Isolation: {col.isolationGuarantee}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* Appwrite Serverless Function Code Preview */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-6 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-indigo-400" />
                  <h3 className="text-sm font-semibold text-white">Appwrite Node.js Serverless Function Implementation</h3>
                </div>
                <span className="text-xs font-mono text-slate-400">/appwrite-functions/gemini-orchestrator/index.js</span>
              </div>
              <p className="text-xs text-slate-400">
                Production-grade serverless handler initializing the official <code className="text-indigo-300">@google/genai</code> SDK, verifying tenant team permissions, enforcing strict JSON Schema, and executing asynchronous updates.
              </p>
              <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 font-mono text-xs text-slate-300 overflow-x-auto max-h-72">
                <pre>{`// Appwrite Serverless Function Entrypoint
import { Client, Databases, Permission, Role, ID } from 'node-appwrite';
import { GoogleGenAI, Type } from '@google/genai';

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);
  const { tenantId, niche, eventType } = JSON.parse(req.body);

  // Tenant Partition Verification
  const tenantDoc = await databases.getDocument('b2b_software_factory', 'tenants', tenantId);
  if (tenantDoc.niche !== niche) {
    return res.json({ status: 'error', code: 'MALFORMED_CONTEXT' }, 400);
  }

  // Google GenAI Structured Call
  const aiResponse = await ai.models.generateContent({
    model: 'gemini-1.5-pro',
    contents: prompt,
    config: { responseMimeType: 'application/json', responseSchema: SCHEMAS[niche] }
  });

  // Asynchronous update with Tenant Scoped Permissions
  await databases.createDocument('b2b_software_factory', 'ai_transformations', ID.unique(), {
    tenant_id: tenantId,
    structured_output: aiResponse.text,
  }, [
    Permission.read(Role.team(tenantId, 'member')),
    Permission.update(Role.team(tenantId, 'admin')),
  ]);

  return res.json({ status: 'success', output: JSON.parse(aiResponse.text) });
};`}</pre>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: GEMINI JSON SCHEMAS */}
        {activeTab === 'gemini' && (
          <div className="space-y-6">
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-base font-semibold text-white">Gemini 1.5 Pro Structured Output Protocol Design</h2>
                  <p className="text-xs text-slate-400">
                    Defines deterministic system consumption schemas using the official <code className="text-indigo-300">@google/genai</code> <code className="text-indigo-300">Type</code> enum.
                  </p>
                </div>
                <span className="text-xs font-mono px-3 py-1 rounded bg-indigo-950 text-indigo-300 border border-indigo-800">
                  Model: Gemini 1.5 Pro / 3.8 Flash
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  {
                    title: 'Real Estate Schema',
                    niche: 'real_estate',
                    keys: ['propertyId', 'estimatedValuationUsd', 'valuationRange', 'marketTrend', 'leadQualityScore', 'riskFactors'],
                    guarantee: 'Zero hallucination on property price bounds',
                  },
                  {
                    title: 'Healthcare Schema',
                    niche: 'healthcare',
                    keys: ['patientCohortId', 'triageUrgencyScore', 'vitalsAnomalyFlag', 'diagnosticCodes', 'redFlagSymptoms'],
                    guarantee: 'Strict HIPAA 18 Safe Harbor PHI elimination',
                  },
                  {
                    title: 'Logistics Schema',
                    niche: 'logistics',
                    keys: ['shipmentTrackingId', 'delayProbabilityPercent', 'temperatureIntegrityBreached', 'rerouteFeasibility'],
                    guarantee: 'Cold-chain thermal excursion trigger detection',
                  },
                ].map((s) => (
                  <div key={s.niche} className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-sm text-white">{s.title}</span>
                      <span className="text-[11px] font-mono text-indigo-400">Type.OBJECT</span>
                    </div>
                    <p className="text-xs text-slate-400">{s.guarantee}</p>
                    <div>
                      <span className="text-[10px] text-slate-500 uppercase font-semibold block mb-1">Required Properties</span>
                      <div className="flex flex-wrap gap-1">
                        {s.keys.map((k) => (
                          <span key={k} className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-800">
                            {k}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-6 bg-slate-950 p-4 rounded-lg border border-slate-800 text-xs font-mono text-slate-300 overflow-x-auto">
                <pre>{`// Example Schema Specification using @google/genai Type enum
export const REAL_ESTATE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    status: { type: Type.STRING },
    confidenceScore: { type: Type.NUMBER },
    nicheSpecificResult: {
      type: Type.OBJECT,
      properties: {
        propertyId: { type: Type.STRING },
        estimatedValuationUsd: { type: Type.NUMBER },
        valuationRange: {
          type: Type.OBJECT,
          properties: { low: { type: Type.NUMBER }, high: { type: Type.NUMBER } },
          required: ["low", "high"],
        },
        marketTrend: { type: Type.STRING },
        leadQualityScore: { type: Type.NUMBER },
        riskFactors: { type: Type.ARRAY, items: { type: Type.STRING } },
        taxAssessmentFlag: { type: Type.BOOLEAN },
      },
      required: ["propertyId", "estimatedValuationUsd", "valuationRange", "marketTrend", "leadQualityScore", "riskFactors"],
    },
    recommendedActions: { type: Type.ARRAY, items: { type: Type.STRING } },
    anomaliesDetected: { type: Type.ARRAY, items: { type: Type.STRING } },
    complianceVerified: { type: Type.BOOLEAN },
  },
  required: ["status", "confidenceScore", "nicheSpecificResult", "recommendedActions", "anomaliesDetected", "complianceVerified"],
};`}</pre>
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: CONSTITUTION & GOVERNANCE */}
        {activeTab === 'governance' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Constitution View */}
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-3">
                <div className="flex items-center gap-2 text-white font-semibold text-sm">
                  <ShieldCheck className="w-4 h-4 text-indigo-400" />
                  <span>Engineering Constitution & Invariants</span>
                </div>
                <div className="space-y-3 text-xs text-slate-300">
                  <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                    <span className="font-semibold text-indigo-300 block mb-1">Article I: Tenant Partitioning & Zero Conflation</span>
                    <p className="text-slate-400 leading-relaxed">
                      Every database record and log MUST be partitioned by tenant_id. No context, credentials, or memory may leak across tenant boundaries. Cross-niche conflation triggers immediate abort.
                    </p>
                  </div>
                  <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                    <span className="font-semibold text-emerald-300 block mb-1">Article II: Deterministic AI Transformation</span>
                    <p className="text-slate-400 leading-relaxed">
                      All Gemini AI calls MUST use strict responseSchema with temperature &lt;= 0.1 to eliminate hallucination. Regulatory guardrails must verify compliance before success.
                    </p>
                  </div>
                  <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                    <span className="font-semibold text-amber-300 block mb-1">Article III: Robustness & Standardized Errors</span>
                    <p className="text-slate-400 leading-relaxed">
                      No silent failures. Incomplete or conflicting metrics emit standardized JSON: <code className="text-red-300">MALFORMED_CONTEXT</code>.
                    </p>
                  </div>
                </div>
              </div>

              {/* Sprints & ADRs */}
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-3">
                <div className="flex items-center gap-2 text-white font-semibold text-sm">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>Architecture Decision Records (ADRs) & Sprints</span>
                </div>
                <div className="space-y-2 text-xs">
                  {[
                    { id: 'ADR-001', title: 'Multi-Tenant Appwrite Database Partitioning', status: 'Accepted' },
                    { id: 'ADR-002', title: 'Gemini Structured Output Protocol & Type Enums', status: 'Accepted' },
                    { id: 'ADR-003', title: 'Rust & Tokio Concurrency Pipeline Engine', status: 'Accepted' },
                  ].map((adr) => (
                    <div key={adr.id} className="bg-slate-950 p-3 rounded-lg border border-slate-800 flex items-center justify-between">
                      <div>
                        <span className="font-mono text-indigo-400 font-semibold">{adr.id}: </span>
                        <span className="text-slate-200">{adr.title}</span>
                      </div>
                      <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-800">
                        {adr.status}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="pt-2 border-t border-slate-800">
                  <span className="text-xs font-semibold text-slate-300 block mb-2">Sprint Roadmap Progress:</span>
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                    <div className="p-2 rounded bg-slate-950 border border-slate-800 text-slate-300 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Sprint 01: Foundation [DONE]</span>
                    </div>
                    <div className="p-2 rounded bg-slate-950 border border-slate-800 text-slate-300 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Sprint 02: Appwrite Fn [DONE]</span>
                    </div>
                    <div className="p-2 rounded bg-slate-950 border border-slate-800 text-slate-300 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Sprint 03: Schemas [DONE]</span>
                    </div>
                    <div className="p-2 rounded bg-slate-950 border border-slate-800 text-slate-300 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Sprint 04: Rust Tokio [DONE]</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Compare Payloads & Schema Drift Modal */}
      <ComparePayloadsModal
        isOpen={showCompareModal}
        onClose={() => setShowCompareModal(false)}
        currentPayload={(() => {
          try {
            return JSON.parse(payloadText);
          } catch {
            return null;
          }
        })()}
        lastSuccessfulPayload={lastSuccessfulPayload}
        onRestoreLastSuccessful={(restored) => {
          setPayloadText(JSON.stringify(restored, null, 2));
        }}
      />
    </div>
  );
}
