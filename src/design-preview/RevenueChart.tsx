import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cn, formatEuro, formatNumber } from '../components/ui';

export interface RevenuePoint {
  key: string;
  shortLabel: string;
  longLabel: string;
  revenue: number;
}

function RevenueTooltip({ point }: { point?: RevenuePoint }) {
  if (!point) return null;
  // Value first and strong, the month second: the reader already knows which
  // bar they are on and wants the number.
  return (
    <div className="rounded-control border border-line bg-overlay px-3 py-2 font-ui shadow-overlay">
      <p className="text-sm font-semibold tabular-nums text-fg">{formatEuro(point.revenue)}</p>
      <p className="text-xs text-fg-muted">{point.longLabel}</p>
    </div>
  );
}

/**
 * One series, monthly revenue, as columns. No legend: the card title names the
 * series. The table tab beside it carries every value, so the chart is marked
 * as a single image for screen readers rather than a keyboard target.
 *
 * recharts writes colours as SVG attributes, and an attribute cannot read a CSS
 * variable. The bars use currentColor from the wrapper's token class; axis text
 * and grid lines get theirs from CSS properties aimed at recharts' own class
 * names, which override the attributes.
 */
export function RevenueChart({ data, label }: { data: RevenuePoint[]; label: string }) {
  return (
    <div
      role="img"
      aria-label={label}
      className={cn(
        // Taller beside the action list on wide screens, so the card does not
        // end in an empty band.
        'h-64 w-full text-brand xl:h-80',
        '[&_.recharts-cartesian-axis-tick-value]:fill-fg-subtle [&_.recharts-cartesian-grid_line]:stroke-line',
      )}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} accessibilityLayer={false}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="shortLabel" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 12 }} />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={64}
            tickCount={5}
            tickFormatter={(value: number) => formatNumber(value)}
            tick={{ fontSize: 12 }}
          />
          <Tooltip
            cursor={{ fill: 'currentColor', fillOpacity: 0.08 }}
            isAnimationActive={false}
            content={props => <RevenueTooltip point={props.payload?.[0]?.payload as RevenuePoint | undefined} />}
          />
          <Bar dataKey="revenue" fill="currentColor" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
