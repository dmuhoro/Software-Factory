import React from 'react';
import { Sliders, ShieldCheck, Database, Check, X, AlertTriangle } from 'lucide-react';
import { TenantConfigFlags } from '../types';

interface Props {
  configs: Record<string, TenantConfigFlags>;
  selectedTenantId: string;
  onSelectTenant: (id: string) => void;
  onToggleFlag: (tenantId: string, flag: keyof TenantConfigFlags) => void;
}

export const TenantSettingsToggle: React.FC<Props> = ({
  configs,
  selectedTenantId,
  onSelectTenant,
  onToggleFlag,
}) => {
  const currentConfig = configs[selectedTenantId] || {
    tenantId: selectedTenantId,
    fairHousingGuardrails: true,
    hipaaStrictRedaction: true,
    coldchainTempAlerting: true,
    autoDbSync: true,
    auditLedgerMirroring: true,
    isActive: true,
  };

  const flags: { key: keyof TenantConfigFlags; title: string; desc: string; impact: string }[] = [
    {
      key: 'fairHousingGuardrails',
      title: 'Fair Housing Non-Discrimination Guardrail',
      desc: 'Enforces RESPA and HUD non-discrimination heuristics in Real Estate AI transformations.',
      impact: currentConfig.fairHousingGuardrails
        ? 'Active: Rejects listing adjustments based on protected demographic classifications.'
        : 'Warning: Disabled; transactions will not receive fair housing compliance stamps.',
    },
    {
      key: 'hipaaStrictRedaction',
      title: 'HIPAA 18 Safe Harbor PHI Redaction',
      desc: 'Quarantines clinical telemetry containing direct patient identifiers (SSN, Full Name, DOB).',
      impact: currentConfig.hipaaStrictRedaction
        ? 'Active: Zero-conflation boundary enforces synthetic cohort IDs only.'
        : 'Critical: Disabled; direct PHI may fail SOC2/HIPAA audit certification.',
    },
    {
      key: 'coldchainTempAlerting',
      title: 'Cold-Chain Thermal Excursion Alerting',
      desc: 'Automates deviation trigger alerts when cargo departs +2.0°C to +8.0°C transport boundaries.',
      impact: currentConfig.coldchainTempAlerting
        ? 'Active: Real-time reroute analysis generated upon thermal breach.'
        : 'Warning: Excursion events will be logged without proactive AI rerouting.',
    },
    {
      key: 'autoDbSync',
      title: 'Automatic Appwrite DB Sync',
      desc: 'Asynchronously updates ai_transformations with Role.team(tenantId, "member") read access.',
      impact: currentConfig.autoDbSync
        ? 'Active: Non-blocking writes dispatched to database collections.'
        : 'Warning: Output delivered only via ephemeral HTTP stream without cloud persistence.',
    },
    {
      key: 'auditLedgerMirroring',
      title: 'Immutable Audit Ledger Mirroring',
      desc: 'Writes cryptographic SHA-256 chain log entries with Permission.read(Role.team(tenantId, "auditor")).',
      impact: currentConfig.auditLedgerMirroring
        ? 'Active: Tamper-evident trail generated for compliance reporting.'
        : 'Warning: Audit trail replication paused for this partition.',
    },
    {
      key: 'isActive',
      title: 'Tenant Partition Active Status',
      desc: 'Global partition kill-switch. When toggled off, incoming requests are rejected with 403 UNAUTHORIZED.',
      impact: currentConfig.isActive
        ? 'Active: Tenant requests accepted and routed through domain adapters.'
        : 'Suspended: Pipeline immediately aborts with UNAUTHORIZED_TENANT error envelope.',
    },
  ];

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-indigo-400" />
          <h3 className="text-sm font-semibold text-white">
            Tenant Configuration Flags & Partition Rule Modifiers
          </h3>
        </div>

        {/* Tenant Partition Selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Selected Partition:</span>
          <select
            value={selectedTenantId}
            onChange={(e) => onSelectTenant(e.target.value)}
            className="bg-slate-950 border border-slate-700 text-slate-200 text-xs font-mono rounded px-2.5 py-1 focus:outline-none focus:border-indigo-500"
          >
            {Object.keys(configs).map((tId) => (
              <option key={tId} value={tId}>
                {tId}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Flags List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {flags.map((item) => {
          const isEnabled = Boolean(currentConfig[item.key]);
          return (
            <div
              key={item.key}
              className={`p-3.5 rounded-lg border transition-all ${
                isEnabled
                  ? 'bg-slate-950/80 border-slate-800'
                  : 'bg-red-950/20 border-red-900/50'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-slate-200">{item.title}</span>
                <button
                  onClick={() => onToggleFlag(selectedTenantId, item.key)}
                  className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out flex items-center ${
                    isEnabled ? 'bg-indigo-600 justify-end' : 'bg-slate-700 justify-start'
                  }`}
                  title="Toggle flag status"
                >
                  <span className="w-4 h-4 rounded-full bg-white shadow-sm"></span>
                </button>
              </div>

              <p className="text-[11px] text-slate-400 leading-normal mb-2">{item.desc}</p>

              <div
                className={`text-[10px] font-mono p-1.5 rounded flex items-center gap-1.5 ${
                  isEnabled
                    ? 'bg-indigo-950/50 text-indigo-300 border border-indigo-900/50'
                    : 'bg-amber-950/50 text-amber-300 border border-amber-900/50'
                }`}
              >
                {isEnabled ? (
                  <Check className="w-3 h-3 text-indigo-400 shrink-0" />
                ) : (
                  <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                )}
                <span className="truncate">{item.impact}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
