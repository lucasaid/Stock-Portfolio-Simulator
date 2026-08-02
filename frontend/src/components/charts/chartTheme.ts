import { ColorType, type ChartOptions, type DeepPartial, type UTCTimestamp } from 'lightweight-charts';

/** lightweight-charts wants seconds since epoch, not milliseconds or ISO strings. */
export function toChartTime(iso: string): UTCTimestamp {
  return Math.floor(Date.parse(iso) / 1000) as UTCTimestamp;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

export function baseChartOptions(height: number): DeepPartial<ChartOptions> {
  const text = cssVar('--text', '#16161a');
  const border = cssVar('--border', '#dcdce3');
  return {
    height,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: text,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: border },
      horzLines: { color: border },
    },
    rightPriceScale: { borderColor: border },
    timeScale: { borderColor: border, timeVisible: true, secondsVisible: false },
    autoSize: true,
  };
}

export const CHART_COLORS = {
  up: '#1a7f4b',
  down: '#c0392b',
  accent: '#6e56cf',
  volume: 'rgba(110, 86, 207, 0.35)',
};
