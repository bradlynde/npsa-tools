"use client";

import { useState } from 'react';
import { COLORS, SCRAPER_LABELS } from '../lib/constants';
import StatusBadge from './StatusBadge';
import type { CountyTask, ScraperType } from '../lib/types';

type SortKey = 'county' | 'status' | 'found' | 'contacts' | 'withEmail' | 'withoutEmail';
type SortDir = 'asc' | 'desc';

function getValue(task: CountyTask, key: SortKey): string | number {
  const r = task.result_json;
  switch (key) {
    case 'county': return task.county;
    case 'status': return task.status;
    case 'found': return r?.churches ?? r?.schools ?? 0;
    case 'contacts': return r?.contacts ?? 0;
    case 'withEmail': return r?.contacts_with_emails ?? 0;
    case 'withoutEmail': return r?.contacts_without_emails ?? 0;
    default: return 0;
  }
}

export default function CountyTable({ counties, scraperType }: {
  counties: CountyTask[];
  scraperType: ScraperType;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('county');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const labels = SCRAPER_LABELS[scraperType];

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sorted = [...counties].sort((a, b) => {
    const va = getValue(a, sortKey);
    const vb = getValue(b, sortKey);
    const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const thStyle: React.CSSProperties = {
    padding: '10px 14px',
    textAlign: 'left',
    fontSize: 11,
    fontWeight: 600,
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    borderBottom: `2px solid ${COLORS.cardBorder}`,
    cursor: 'pointer',
    userSelect: 'none',
  };

  const tdStyle: React.CSSProperties = {
    padding: '10px 14px',
    fontSize: 13,
    color: COLORS.textPrimary,
    borderBottom: `1px solid ${COLORS.cardBorder}`,
  };

  const arrow = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '';

  return (
    <div className="table-responsive" style={{
      background: COLORS.cardBg,
      borderRadius: 12,
      overflow: 'hidden',
      boxShadow: COLORS.cardShadow,
      border: `1px solid ${COLORS.cardBorder}`,
    }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={thStyle} onClick={() => handleSort('county')}>County{arrow('county')}</th>
            <th style={thStyle} onClick={() => handleSort('status')}>Status{arrow('status')}</th>
            <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => handleSort('found')}>{labels.plural} Found{arrow('found')}</th>
            <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => handleSort('contacts')}>Contacts{arrow('contacts')}</th>
            <th style={thStyle}>Worker</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((task, i) => {
            const r = task.result_json;
            return (
              <tr key={task.id || task.county} style={{ background: i % 2 === 1 ? 'var(--hover)' : 'transparent' }}>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{task.county}</td>
                <td style={tdStyle}><StatusBadge status={task.status} /></td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>{r?.churches ?? r?.schools ?? '-'}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>{r?.contacts ?? '-'}</td>
                <td style={{ ...tdStyle, fontSize: 11, color: COLORS.textMuted }}>{task.claimed_by ? task.claimed_by.substring(0, 12) : '-'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
