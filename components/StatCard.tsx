import type { ReactNode } from 'react';

/**
 * Stat tile for the run screens. Mirrors StatTile in components/ui.tsx —
 * mono label, serif figure — but keeps this component's own prop shape so the
 * run detail and new-run screens don't need rewriting.
 */
export default function StatCard({ label, value, subtitle, icon }: {
  label: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
}) {
  return (
    <div
      className="lift"
      style={{
        background: 'var(--card)',
        borderRadius: 16,
        padding: '20px 22px',
        boxShadow: 'var(--shadow-card)',
        border: '1px solid var(--bd)',
        flex: 1,
        minWidth: 160,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div
            className="mono"
            style={{
              fontWeight: 500,
              fontSize: 11.5,
              letterSpacing: '.07em',
              color: 'var(--mute)',
              marginBottom: 11,
            }}
          >
            {label.toLowerCase()}
          </div>
          <div className="kpi" style={{ fontSize: 34, color: 'var(--ink)' }}>
            {typeof value === 'number' ? value.toLocaleString() : value}
          </div>
          {subtitle && (
            <div style={{ fontSize: 12.5, color: 'var(--mute)', marginTop: 9 }}>
              {subtitle}
            </div>
          )}
        </div>
        {icon && (
          <div style={{ fontSize: 24, color: 'var(--navy)', opacity: 0.6 }}>
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
