import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Histogram } from '../src/components/charts/Histogram';
import { Scatter } from '../src/components/charts/Scatter';

const buckets = [
  { fromPct: -10, toPct: -5, count: 1 },
  { fromPct: -5, toPct: 0, count: 2 },
  { fromPct: 0, toPct: 5, count: 4 },
  { fromPct: 5, toPct: 10, count: 1 },
];

const points = [
  { symbol: 'AAPL', holdMs: 86_400_000, returnPct: 12, netCents: 400, closedAt: '2026-08-02T00:00:00.000Z' },
  { symbol: 'MSFT', holdMs: 3 * 86_400_000, returnPct: -4, netCents: -200, closedAt: '2026-08-05T00:00:00.000Z' },
];

describe('Histogram', () => {
  it('draws one bar per bucket', () => {
    const { container } = render(<Histogram buckets={buckets} />);
    expect(container.querySelectorAll('rect.bar')).toHaveLength(4);
  });

  it('scales bar height to the tallest bucket', () => {
    const { container } = render(<Histogram buckets={buckets} height={100} />);
    const heights = [...container.querySelectorAll('rect.bar')].map((r) => Number(r.getAttribute('height')));
    expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights));
    expect(Math.max(...heights)).toBeLessThanOrEqual(100);
  });

  it('colours losing buckets differently from winning ones', () => {
    const { container } = render(<Histogram buckets={buckets} />);
    const bars = [...container.querySelectorAll('rect.bar')];
    expect(bars[0]!.getAttribute('fill')).not.toBe(bars[2]!.getAttribute('fill'));
  });

  it('labels the axis extremes and is described for screen readers', () => {
    render(<Histogram buckets={buckets} />);
    expect(screen.getByText('-10%')).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(/distribution/i);
  });

  it('renders an empty state with no buckets', () => {
    render(<Histogram buckets={[]} />);
    expect(screen.getByText(/no closed trades/i)).toBeInTheDocument();
  });

  it('survives a single bucket without a zero-height division', () => {
    const { container } = render(<Histogram buckets={[{ fromPct: 0, toPct: 5, count: 3 }]} height={80} />);
    const height = Number(container.querySelector('rect.bar')!.getAttribute('height'));
    expect(height).toBe(80);
  });
});

describe('Scatter', () => {
  it('plots one point per round trip', () => {
    const { container } = render(<Scatter points={points} />);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });

  it('colours winners and losers differently', () => {
    const { container } = render(<Scatter points={points} />);
    const circles = [...container.querySelectorAll('circle')];
    expect(circles[0]!.getAttribute('fill')).not.toBe(circles[1]!.getAttribute('fill'));
  });

  it('titles each point with its symbol and return', () => {
    const { container } = render(<Scatter points={points} />);
    const titles = [...container.querySelectorAll('title')].map((t) => t.textContent);
    expect(titles.some((t) => t?.includes('AAPL') && t.includes('12.0%'))).toBe(true);
  });

  it('handles a single point without dividing by a zero range', () => {
    const { container } = render(<Scatter points={[points[0]!]} />);
    const circle = container.querySelector('circle')!;
    expect(Number(circle.getAttribute('cx'))).not.toBeNaN();
    expect(Number(circle.getAttribute('cy'))).not.toBeNaN();
  });

  it('renders an empty state with no points', () => {
    render(<Scatter points={[]} />);
    expect(screen.getByText(/no closed trades/i)).toBeInTheDocument();
  });
});
