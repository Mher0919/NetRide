// apps/admin_dashboard/src/components/SpeedingBadge.tsx
//
// Small chip rendered next to a driver's name when they are flagged
// as dangerous. Terracotta when dangerous, stone when merely flagged.
// Click to drill into the driver's safety history.

import React from 'react';
import { Link } from 'react-router-dom';

interface Props {
  isDangerous: boolean;
  isFlagged?: boolean;
  driverId?: string;
  size?: 'sm' | 'md';
}

// Brand palette — kept in sync with apps/driver_flutter/lib/theme/app_theme.dart.
// terracotta = #C65A5A, gold = #C79A4A, dark-forest = #2F3A32, stone = #D8D2CA.
const COLORS = {
  terracotta: '#C65A5A',
  gold: '#C79A4A',
  darkForest: '#2F3A32',
  stone: '#D8D2CA',
  white: '#ffffff',
};

export const SpeedingBadge: React.FC<Props> = ({
  isDangerous,
  isFlagged,
  driverId,
  size = 'md',
}) => {
  if (!isDangerous && !isFlagged) return null;

  const label = isDangerous ? 'Dangerous' : 'Flagged';
  const bg = isDangerous ? COLORS.terracotta : COLORS.gold;
  const fg = isDangerous ? COLORS.white : COLORS.darkForest;

  const padding = size === 'sm' ? '2px 8px' : '3px 10px';
  const fontSize = size === 'sm' ? 10 : 11;

  const chip = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding,
        background: bg,
        color: fg,
        fontSize,
        fontWeight: 700,
        letterSpacing: 0.5,
        borderRadius: 999,
        textTransform: 'uppercase',
      }}
      title={
        isDangerous
          ? '3+ speeding trips in the last 90 days'
          : 'Driver under review for speeding'
      }
    >
      <span aria-hidden style={{ fontSize: 10 }}>⚠</span>
      {label}
    </span>
  );

  if (driverId) {
    return (
      <Link
        to={`/users/${driverId}`}
        style={{ textDecoration: 'none' }}
        aria-label={`View safety history for driver ${driverId}`}
      >
        {chip}
      </Link>
    );
  }
  return chip;
};