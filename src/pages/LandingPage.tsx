import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  TrendingUp, Users, Wallet, FileText, Car, Wrench, BarChart3,
  ChevronRight, CheckCircle, ArrowRight, Shield, Zap, Globe,
  DollarSign, Target, AlertTriangle, Clock, Star, Menu, X,
  TrendingDown, Calendar, ChevronDown, Receipt, Settings, CreditCard,
} from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { LEGAL_PATHS } from '../lib/legalPages';
import { Button, Badge } from '../components/ui';
import { cn } from '../components/ui/cn';
import BrandLogo from '../components/BrandLogo';

// ── Presentation (phase 5) ───────────────────────────────────────────────────
// The landing page follows the theme like every other signed-out screen: the
// body paints the canvas and the ambient glow, and every pane is a glass class
// or a token. Nothing on this page draws a hex colour.

// ─── Shared primitives ────────────────────────────────────────────────────────

const GradientText: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-brand-text">
    {children}
  </span>
);

const Tag: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="mb-4 inline-block text-[11px] font-bold uppercase tracking-[0.12em] text-brand-text">
    {children}
  </span>
);

// A negative letter-spacing breaks the joins of Arabic script, so every
// tightened heading releases it in right-to-left.
const SECTION_SPACING = 'relative z-10';
const SECTION_PAD = 'px-4 py-[72px] md:px-5 md:py-[120px]';
const SECTION_PAD_COMPACT = 'px-4 py-14 md:px-5 md:py-20';
const SECTION_HEAD = 'mx-auto mb-16 max-w-[600px] text-center';
const H2_BASE = 'mb-[18px] font-semibold leading-[1.1] tracking-[-0.025em] rtl:tracking-normal';
const H2_CLASS = `${H2_BASE} text-[length:clamp(28px,4vw,52px)]`;
const BODY_CLASS = 'text-[15px] leading-[1.65] text-fg-muted';
const CHECK_ROW = 'mb-[7px] flex items-center gap-2 text-xs text-fg-muted';

// ─── Mini charts ─────────────────────────────────────────────────────────────

const BarChart: React.FC = () => {
  const bars = [40, 58, 45, 70, 62, 85, 68, 90, 75, 96, 80, 100];
  // Drawn as SVG so a bar's height and tint (data) are attributes, not styles.
  return (
    <svg viewBox="0 0 120 40" preserveAspectRatio="none" className="h-10 w-full" aria-hidden>
      {bars.map((h, i) => (
        <rect
          key={i}
          x={i * 10 + 1} width={8}
          y={40 - (h / 100) * 40} height={(h / 100) * 40}
          className="fill-chart-1"
          fillOpacity={i >= bars.length - 3 ? 1 : 0.2 + (i / bars.length) * 0.35}
        />
      ))}
    </svg>
  );
};

const LineChart: React.FC = () => {
  const pts = [18, 28, 22, 42, 36, 55, 48, 66, 58, 74, 68, 88];
  const W = 130, H = 44, max = 88;
  const d = pts.map((v, i) => `${(i / (pts.length - 1)) * W},${H - (v / max) * H}`).join(' ');
  return (
    <svg width={W} height={H} className="overflow-visible rtl:-scale-x-100" aria-hidden>
      <defs>
        <linearGradient id="lf" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(var(--chart-1))" stopOpacity="0.25" />
          <stop offset="100%" stopColor="rgb(var(--chart-1))" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${d} ${W},${H}`} fill="url(#lf)" />
      <polyline points={d} fill="none" className="stroke-chart-1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

const RingChart: React.FC<{ pct: number; size?: number }> = ({ pct, size = 44 }) => {
  const r = size / 2 - 5, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} className="-rotate-90" aria-hidden>
      <circle cx={size/2} cy={size/2} r={r} fill="none" className="stroke-line" strokeWidth="4" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" className="stroke-chart-1" strokeWidth="4"
        strokeDasharray={`${(pct/100)*c} ${c}`} strokeLinecap="round" />
    </svg>
  );
};

// ─── Hero dashboard mockup ────────────────────────────────────────────────────

const MOCK_LABEL = 'mb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-fg-subtle rtl:tracking-normal';
const FLOAT_CARD = 'glass-strong absolute hidden w-[148px] cursor-default rounded-tile px-3.5 py-3 transition-[box-shadow,border-color] duration-300 hover:border-brand/40 lg:block';
const FLOAT_DOT = 'absolute end-2 top-2 size-1.5 rounded-full motion-safe:animate-[dot-pulse_2s_ease-in-out_infinite]';
const FLOAT_DELTA = 'mt-[3px] flex items-center gap-1 text-[10px] font-bold text-positive';

const HeroDashboard: React.FC = () => {
  const { t } = useTranslation();
  return (
  <div className="relative mx-auto w-full max-w-[600px]">
    {/* Glow halo */}
    <div className="pointer-events-none absolute -inset-[20%] rounded-full bg-brand/10 blur-[30px]" />

    {/* Main panel */}
    <div className="glass-card relative overflow-hidden rounded-pane shadow-overlay">
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 border-b border-line px-4 py-3">
        <span className="size-2.5 rounded-full bg-critical-dot/60" />
        <span className="size-2.5 rounded-full bg-caution-dot/60" />
        <span className="size-2.5 rounded-full bg-positive-dot/60" />
        <span className="flex-1" />
        <span dir="ltr" className="font-mono text-[10px] text-fg-subtle">El-Professor · Dashboard</span>
      </div>

      <div className="flex flex-col gap-3.5 p-[18px]">
        {/* KPIs */}
        <div className="grid grid-cols-3 gap-2.5">
          {[
            { l: t('landing.mock.kpiRevenue'), v: '28.450 €', d: '+12.4%', pos: true },
            { l: t('landing.mock.kpiProfit'), v: '8.720 €', d: '+8.1%', pos: true },
            { l: t('nav.fahrer'), v: t('landing.mock.kpiDriversValue'), d: null, pos: true },
          ].map((k, i) => (
            <div key={i} className="rounded-tile border border-line bg-sunken px-3 py-2.5">
              <div className={MOCK_LABEL}>{k.l}</div>
              <div className="text-[13px] font-bold tabular-nums text-fg">{k.v}</div>
              {k.d && <div className={cn('mt-0.5 text-[10px] font-bold tabular-nums', k.pos ? 'text-positive' : 'text-critical')}>{k.d}</div>}
            </div>
          ))}
        </div>

        {/* Chart */}
        <div className="rounded-tile border border-line bg-sunken px-3.5 py-3">
          <div className="mb-2.5 flex items-center justify-between">
            <div>
              <div className="text-[10px] font-semibold text-fg-muted">{t('landing.mock.trendTitle')}</div>
              <div className="text-[10px] text-fg-subtle">{t('landing.mock.trendSub')}</div>
            </div>
            <Badge tone="positive" className="h-[18px] text-[10px] tabular-nums">+12.4%</Badge>
          </div>
          <BarChart />
        </div>

        {/* Bottom panels */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-tile border border-line bg-sunken px-3 py-2.5">
            <div className={cn(MOCK_LABEL, 'mb-2')}>{t('landing.mock.incomeMix')}</div>
            <div className="flex items-center gap-2.5">
              <RingChart pct={68} />
              <div className="flex flex-col gap-1">
                {[['bg-chart-1',t('landing.mock.legendFare')],['bg-chart-2',t('landing.mock.legendCash')],['bg-chart-3',t('landing.mock.legendTip')]].map(([c,l],i) => (
                  <div key={i} className="flex items-center gap-[5px] text-[10px] text-fg-muted">
                    <span className={cn('size-1.5 shrink-0 rounded-full', c)} />
                    {l}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-tile border border-line bg-sunken px-3 py-2.5">
            <div className={cn(MOCK_LABEL, 'mb-2')}>{t('landing.mock.topDrivers')}</div>
            {['Ahmad K.','Klaus M.','Mehmet A.'].map((n,i) => (
              <div key={i} className="mb-1.5 flex items-center gap-1.5">
                <span className="w-2.5 text-[10px] font-extrabold text-fg-subtle">{i+1}</span>
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
                  <div className={cn('h-full rounded-full bg-chart-1', ['w-[88%]', 'w-[70%]', 'w-[52%]'][i])} />
                </div>
                <span className="w-[50px] overflow-hidden whitespace-nowrap text-[10px] text-fg-muted">{n}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Alert bar */}
        <div className="flex items-center gap-2 rounded-control border border-caution-dot/30 bg-caution-soft px-3 py-2">
          <AlertTriangle size={11} className="shrink-0 text-caution" />
          <span className="text-[10px] text-caution">{t('landing.mock.alert')}</span>
          <span className="ms-auto text-[10px] font-bold text-caution">{t('landing.mock.alertAction')}</span>
        </div>
      </div>
    </div>

    {/* Floating card 1 — Bargeld */}
    <div className={cn(FLOAT_CARD, 'hero-float-card-1 start-[-60px] top-20')}>
      <div className={MOCK_LABEL}>{t('landing.mock.cashLabel')}</div>
      <div className="text-lg font-bold tabular-nums text-fg">3.920 €</div>
      <div className={FLOAT_DELTA}>
        <TrendingUp size={8} /> {t('landing.mock.cashDelta')}
      </div>
      <span className={cn(FLOAT_DOT, 'bg-brand')} />
    </div>

    {/* Floating card 2 — Flotte */}
    <div className={cn(FLOAT_CARD, 'hero-float-card-2 end-[-28px] top-[100px] w-[142px]')}>
      <div className={MOCK_LABEL}>{t('landing.mock.fleetLabel')}</div>
      <div className="text-lg font-bold tabular-nums text-fg">8 / 9 OK</div>
      <div className={FLOAT_DELTA}>
        <Car size={8} /> {t('landing.mock.fleetAllActive')}
      </div>
      <span className={cn(FLOAT_DOT, 'bg-violet-dot [animation-delay:0.6s]')} />
    </div>

    {/* Floating card 3 — Gewinnmarge */}
    <div className={cn(FLOAT_CARD, 'hero-float-card-3 bottom-20 end-[-28px]')}>
      <div className={MOCK_LABEL}>{t('landing.mock.marginLabel')}</div>
      <div className="text-lg font-bold tabular-nums text-fg">30.6%</div>
      <div className={FLOAT_DELTA}>
        <TrendingUp size={8} /> +2.1pp
      </div>
      <span className={cn(FLOAT_DOT, 'bg-caution-dot [animation-delay:1.1s]')} />
    </div>
  </div>
  );
};

// ─── Pain stat card ───────────────────────────────────────────────────────────

const PAIN_ACCENT: Record<string, { bar: string; text: string }> = {
  brand: { bar: 'bg-brand', text: 'text-brand-text' },
  violet: { bar: 'bg-violet-dot', text: 'text-violet' },
  positive: { bar: 'bg-positive-dot', text: 'text-positive' },
  info: { bar: 'bg-info-dot', text: 'text-info' },
};

const PainCard: React.FC<{ value: string; label: string; desc: string; accent: string }> = ({ value, label, desc, accent }) => (
  <div className="glass-card relative overflow-hidden rounded-surface px-6 py-7">
    <div className={cn('absolute inset-x-0 top-0 h-0.5', PAIN_ACCENT[accent]?.bar)} />
    <div className={cn('mb-1 text-[40px] font-semibold tabular-nums tracking-[-0.03em] rtl:tracking-normal', PAIN_ACCENT[accent]?.text)}>
      {value}
    </div>
    <div className="mb-1.5 text-[13px] font-semibold text-fg">{label}</div>
    <div className="text-xs leading-[1.6] text-fg-muted">{desc}</div>
  </div>
);

// ─── Feature card ─────────────────────────────────────────────────────────────

const FEATURE_ACCENT: Record<string, string> = {
  brand: 'bg-brand-soft text-brand-text',
  violet: 'bg-violet-soft text-violet',
  teal: 'bg-teal-soft text-teal',
  caution: 'bg-caution-soft text-caution',
  positive: 'bg-positive-soft text-positive',
  info: 'bg-info-soft text-info',
};

/**
 * The prop is `accent`, as on `PainCard` above, because that is the key the
 * twelve card literals below pass through `{...f}`. It was `accentColor`, so
 * every one of the twelve rendered `background: 'undefined18'`, a border of
 * `'undefined30'`, a hover border of `'undefined33'` and an undefined icon
 * colour — on the product's own front page, on every visit. Renaming the prop
 * rather than the twelve literals keeps the data untouched and keeps the two
 * card components naming the same thing the same way. It names a tone now, not
 * a colour: the tile's classes come from FEATURE_ACCENT.
 */
const FeatureCard: React.FC<{
  icon: React.ReactNode; title: string; desc: string; accent: string;
}> = ({ icon, title, desc, accent }) => (
  <div className="glass-card cursor-default rounded-surface px-5 py-[22px] transition-[border-color,background-color] duration-300 hover:border-line-strong hover:bg-raised/[1.4]">
    <div className={cn('mb-3.5 flex size-10 items-center justify-center rounded-control', FEATURE_ACCENT[accent])}>
      {icon}
    </div>
    <div className="mb-1.5 text-[13px] font-semibold text-fg">{title}</div>
    <div className="text-xs leading-[1.65] text-fg-muted">{desc}</div>
  </div>
);

// ─── Screenshot panel ─────────────────────────────────────────────────────────

const ScreenPanel: React.FC<{ title: string; subtitle: string; children: React.ReactNode; tag?: string }> = ({ title, subtitle, children, tag }) => (
  <div className="glass-card overflow-hidden rounded-pane shadow-overlay">
    <div className="flex items-center gap-1.5 border-b border-line px-3.5 py-2.5">
      <span className="size-[9px] rounded-full bg-critical-dot/60" />
      <span className="size-[9px] rounded-full bg-caution-dot/60" />
      <span className="size-[9px] rounded-full bg-positive-dot/60" />
      <span className="flex-1" />
      {tag && <Badge tone="brand" className="h-[18px] text-[10px]">{tag}</Badge>}
    </div>
    <div className="p-[18px]">
      <div className="mb-[3px] text-xs font-semibold text-fg">{title}</div>
      <div className="mb-3.5 text-[11px] text-fg-subtle">{subtitle}</div>
      {children}
    </div>
  </div>
);

// ─── Abrechnung mockup ────────────────────────────────────────────────────────

const AbrechnungPanel: React.FC = () => {
  const { t } = useTranslation();
  return (
  <ScreenPanel
    title={t('landing.mock.abrechnungTitle')}
    subtitle={t('landing.mock.abrechnungSub')}
    tag={t('landing.mock.abrechnungTag')}
  >
    {[
      { name: 'Ahmad K.', umsatz: '2.840 €', lohn: '1.136 €', status: t('landing.mock.statusPaid'), color: 'text-positive' },
      { name: 'Klaus M.', umsatz: '2.290 €', lohn: '916 €', status: t('landing.mock.statusOpen'), color: 'text-caution' },
      { name: 'Mehmet A.', umsatz: '3.110 €', lohn: '1.244 €', status: t('landing.mock.statusPaid'), color: 'text-positive' },
      { name: 'Stefan B.', umsatz: '1.960 €', lohn: '784 €', status: t('landing.mock.statusOpen'), color: 'text-caution' },
    ].map((r, i) => (
      <div key={i} className={cn('flex items-center py-2', i < 3 ? 'border-b border-line' : '')}>
        <div className="me-2.5 flex size-[26px] shrink-0 items-center justify-center rounded-full bg-brand-gradient text-[10px] font-extrabold text-brand-fg">
          {r.name.charAt(0)}
        </div>
        <div className="flex-1">
          <div className="text-[11px] font-semibold text-fg">{r.name}</div>
          <div className="text-[10px] text-fg-subtle">{t('landing.mock.kpiRevenue')} {r.umsatz}</div>
        </div>
        <div className="text-end">
          <div className="text-xs font-bold tabular-nums text-fg">{r.lohn}</div>
          <div className={cn('text-[10px] font-bold', r.color)}>{r.status}</div>
        </div>
      </div>
    ))}
    <div className="mt-3 flex items-center justify-between rounded-control border border-brand/20 bg-brand-soft px-3 py-2.5">
      <span className="text-[11px] text-fg-muted">{t('landing.mock.totalOpen')}</span>
      <span className="text-sm font-bold tabular-nums text-brand-text">1.700 €</span>
    </div>
  </ScreenPanel>
  );
};

// ─── Kasse mockup ─────────────────────────────────────────────────────────────

const KassePanel: React.FC = () => {
  const { t } = useTranslation();
  return (
  <ScreenPanel title={t('landing.mock.kasseTitle')} subtitle={t('landing.mock.kasseSub')}>
    <div className="mb-3.5">
      <div className={MOCK_LABEL}>{t('landing.mock.currentBalance')}</div>
      <div className="text-[32px] font-semibold tabular-nums tracking-[-0.03em] text-brand-text rtl:tracking-normal">
        4.380 €
      </div>
      <div className="mt-0.5 text-[11px] font-bold text-positive">{t('landing.mock.vsYesterday')}</div>
    </div>
    <div className="mb-2.5">
      <LineChart />
    </div>
    <div className="flex flex-col gap-1.5">
      {[
        { l: t('landing.mock.incomeToday'), v: '+840 €', c: 'text-positive' },
        { l: t('landing.mock.expensesToday'), v: '-520 €', c: 'text-critical' },
        { l: t('landing.mock.difference'), v: '+320 €', c: 'text-brand-text' },
      ].map((row,i) => (
        <div key={i} className="flex justify-between rounded-tight bg-sunken px-2.5 py-1.5">
          <span className="text-[11px] text-fg-muted">{row.l}</span>
          <span dir="ltr" className={cn('text-[11px] font-bold tabular-nums', row.c)}>{row.v}</span>
        </div>
      ))}
    </div>
  </ScreenPanel>
  );
};

// ─── Fuhrpark mockup ─────────────────────────────────────────────────────────

const FuhrparkPanel: React.FC = () => {
  const { t } = useTranslation();
  return (
  <ScreenPanel title={t('landing.mock.fleetTitle')} subtitle={t('landing.mock.fleetSub')}>
    {[
      // 'OK' reads the same in both languages, so only the due-for-inspection
      // status needs the dictionary.
      { kz: 'SG-AB 1234', mod: 'Mercedes Vito', km: '98.400', status: 'OK', c: 'positive' as const },
      { kz: 'SG-CD 5678', mod: 'VW Crafter', km: '112.800', status: t('landing.mock.statusInspection'), c: 'caution' as const },
      { kz: 'SG-EF 9012', mod: 'Ford Transit', km: '76.200', status: 'OK', c: 'positive' as const },
      { kz: 'SG-GH 3456', mod: 'Mercedes Vito', km: '154.300', status: 'OK', c: 'positive' as const },
    ].map((v, i) => (
      <div key={i} className={cn('flex items-center py-[7px]', i < 3 ? 'border-b border-line' : '')}>
        <div className="me-2.5 flex size-7 shrink-0 items-center justify-center rounded-control border border-line bg-sunken">
          <Car size={13} className="text-fg-subtle" />
        </div>
        <div className="flex-1">
          <div dir="ltr" className="font-mono text-[11px] font-bold text-fg">{v.kz}</div>
          <div className="text-[10px] text-fg-subtle">{v.mod} · {v.km} km</div>
        </div>
        <Badge tone={v.c} className="h-[18px] text-[10px]">{v.status}</Badge>
      </div>
    ))}
  </ScreenPanel>
  );
};

// ─── Pricing ──────────────────────────────────────────────────────────────────

import { calcPricing, fleetDiscountPercent, fmtPricePerCar, fmt as fmtPrice } from '../utils/pricing';
import { fleetDiscountSummary } from '../utils/pricingText';
import { useAppConfig } from '../contexts/AppConfigContext';
import type { Plan as PricingPlan } from '../contexts/PlanContext';

// `label` is the product tier name and stays untranslated. `sub`, `badge` and
// `features` hold TranslationKeys: this list is module-level and t() is a hook
// value, so every consumer resolves it at the render site.
const PRICING_PLANS: {
  id: PricingPlan;
  label: string;
  sub: TranslationKey;
  highlight: boolean;
  badge: TranslationKey | '';
  features: TranslationKey[];
}[] = [
  {
    id: 'basic', label: 'Basic', sub: 'landing.plan.basicSub',
    highlight: false, badge: '',
    features: ['nav.overview','nav.belege','nav.fahrer','nav.cars','nav.umsaetze','nav.fixkosten','nav.bargeldbestand','landing.plan.feature.backup','landing.plan.feature.excelExport'],
  },
  {
    id: 'advanced', label: 'Advanced', sub: 'landing.plan.advancedSub',
    highlight: true, badge: 'landing.plan.badgeMostPopular',
    features: ['nav.overview','nav.belege','nav.fahrer','nav.cars','nav.umsaetze','nav.fixkosten','nav.bargeldbestand','landing.plan.feature.backup','landing.plan.feature.excelExport','nav.werkstatt','nav.abrechnung','landing.plan.feature.note','locked.feature.rollenNutzer'],
  },
  {
    id: 'premium', label: 'Premium', sub: 'landing.plan.premiumSub',
    highlight: false, badge: '',
    features: ['nav.overview','nav.belege','nav.fahrer','nav.cars','nav.umsaetze','nav.fixkosten','nav.bargeldbestand','landing.plan.feature.backup','landing.plan.feature.excelExport','nav.werkstatt','nav.abrechnung','landing.plan.feature.note','locked.feature.rollenNutzer','nav.salaries','nav.documents'],
  },
];

const PricingSection: React.FC = () => {
  const { t, tPlural } = useTranslation();
  // Every number on this section comes from the price book the database holds
  // (plan 3.9), which is also what compute_plan_price charges from. Until the
  // first answer arrives it is the seed, which is what the database was
  // seeded with, so the page never renders without prices.
  const { priceBook } = useAppConfig();
  const [billing, setBilling] = useState<'monthly'|'yearly'>('monthly');
  const [carCount, setCarCount] = useState(5);

  const fleetPct = fleetDiscountPercent(priceBook, carCount);

  return (
    <section id="pricing" className={cn(SECTION_SPACING, SECTION_PAD)}>
      <div className="mx-auto max-w-[1140px]">
        <div className="mx-auto mb-4 max-w-[560px] text-center">
          <Tag>{t('landing.nav.pricing')}</Tag>
          <h2 className={cn(H2_BASE, 'mb-4 text-[length:clamp(32px,4vw,48px)]')}>
            {t('landing.pricing.titleLead')} <GradientText>{t('landing.pricing.titleHighlight')}</GradientText>
          </h2>
          <p className="text-[15px] leading-[1.65] text-fg-muted">
            {t('landing.pricing.body')}
          </p>
        </div>

        {/* Controls row: billing toggle + car count slider */}
        <div className="mb-[52px] flex flex-wrap items-center justify-center gap-6">

          {/* Billing toggle */}
          <div className="inline-flex items-center gap-1 rounded-full border border-line bg-sunken p-1">
            {(['monthly','yearly'] as const).map(b => (
              <Button key={b} variant={billing === b ? 'primary' : 'ghost'} onClick={() => setBilling(b)} className="gap-2 rounded-full px-5 font-bold">
                {b === 'monthly' ? t('landing.pricing.monthly') : (
                  <><span>{t('landing.pricing.yearly')}</span>
                  <span className={cn('rounded-full px-1.5 py-px text-[10px] font-extrabold tabular-nums', billing === 'yearly' ? 'bg-brand-fg/20 text-brand-fg' : 'bg-brand-soft text-brand-text')}>-{priceBook.yearly_discount_percent}%</span>
                  </>
                )}
              </Button>
            ))}
          </div>

          {/* Car count slider */}
          <div className="flex flex-wrap items-center justify-center gap-3.5">
            <span className="whitespace-nowrap text-xs font-semibold text-fg-subtle">{t('landing.pricing.vehiclesLabel')}</span>
            <input
              type="range" min={1} max={20} value={carCount}
              onChange={e => setCarCount(Number(e.target.value))}
              className="w-[140px] cursor-pointer accent-brand [@media(pointer:coarse)]:h-11"
            />
            <span className="min-w-[30px] rounded-control border border-brand/20 bg-brand-soft px-2 py-0.5 text-center text-[15px] font-bold tabular-nums text-fg">{carCount}</span>
            {fleetPct > 0 && (
              <Badge tone="positive" className="tabular-nums">
                -{fleetPct}% {t('landing.pricing.fleetDiscount')}
              </Badge>
            )}
          </div>
        </div>

        {/* Cards */}
        <div className="mx-auto grid max-w-[1080px] grid-cols-1 items-center justify-center justify-items-center gap-5 lg:grid-cols-3">
          {PRICING_PLANS.map((p) => {
            const bp = calcPricing(priceBook, p.id, carCount, billing);
            const displayMonthly = bp.monthlyEquivalent;
            const displayYearly  = bp.yearlyTotal;
            return (
              <div key={p.id} className={cn(
                'glass-card relative flex w-full max-w-[420px] flex-col rounded-pane',
                p.highlight ? 'border-brand/40 px-7 py-8 shadow-brand' : 'mt-3 px-6 py-7',
              )}>
                {p.badge && (
                  <div className="absolute -top-3.5 start-1/2 z-[2] -translate-x-1/2 rtl:translate-x-1/2">
                    <span className="inline-flex items-center gap-[5px] whitespace-nowrap rounded-full bg-brand-gradient px-4 py-[5px] text-[11px] font-extrabold text-brand-fg shadow-brand">
                      <Star size={9} className="fill-current" /> {t(p.badge as TranslationKey)}
                    </span>
                  </div>
                )}

                <div className="mb-3">
                  <div className="mb-0.5 text-[17px] font-bold text-fg">{p.label}</div>
                  <div className="text-xs text-fg-subtle">{t(p.sub)}</div>
                </div>

                {/* Price per car badge */}
                <div className="mb-2.5">
                  <Badge tone="brand" className="tabular-nums">
                    {fmtPricePerCar(priceBook.price_per_car_cents[p.id])} € {t('landing.pricing.perVehiclePerMonth')}
                  </Badge>
                </div>

                {/* Main price display */}
                <div className="mb-1.5">
                  <div className="flex items-baseline gap-1">
                    <span className="text-[44px] font-semibold leading-none tabular-nums tracking-[-0.03em] text-fg rtl:tracking-normal">
                      {fmtPrice(displayMonthly)}€
                    </span>
                    <span className="text-[13px] text-fg-subtle">{t('landing.pricing.perMonth')}</span>
                  </div>
                  {billing === 'yearly' && (
                    <div className="mt-0.5 text-xs tabular-nums text-fg-subtle">
                      = {fmtPrice(displayYearly)} € {t('landing.pricing.perYearInclDiscount', { pct: priceBook.yearly_discount_percent })}
                    </div>
                  )}
                </div>

                {/* Discount pills */}
                <div className="mb-5 flex flex-wrap gap-1.5">
                  {bp.fleetDiscountPct > 0 && (
                    <Badge tone="positive" className="tabular-nums">
                      -{bp.fleetDiscountPct}% {t('landing.pricing.fleetDiscount')}
                    </Badge>
                  )}
                  {billing === 'yearly' && (
                    <Badge tone="caution" className="tabular-nums">
                      -{priceBook.yearly_discount_percent}% {t('landing.pricing.yearlyDiscount')}
                    </Badge>
                  )}
                </div>

                <Button asChild variant={p.highlight ? 'primary' : 'secondary'} size="lg" className="mb-5 w-full font-bold">
                  <a href="/signup">
                    {t('landing.pricing.cta')}
                  </a>
                </Button>

                <div className={cn('mb-5 h-px', p.highlight ? 'bg-brand/20' : 'bg-line')} />

                <ul className="m-0 flex list-none flex-col gap-[9px] p-0">
                  {p.features.map((featureKey, j) => (
                    <li key={j} className="flex items-center gap-2.5 text-[13px] text-fg-muted">
                      <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full', p.highlight ? 'bg-brand-soft' : 'bg-sunken')}>
                        <CheckCircle size={9} className={p.highlight ? 'text-brand-text' : 'text-fg-subtle'} />
                      </span>
                      {t(featureKey)}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        {/* Pricing explanation */}
        <div className="mx-auto mt-10 max-w-[700px] rounded-surface border border-line bg-sunken px-6 py-5">
          <p className="m-0 text-center text-xs leading-[1.7] text-fg-subtle">
            <strong className="text-fg-muted">{t('landing.pricing.fleetDiscount')}:</strong> {fleetDiscountSummary(priceBook, t, tPlural)}
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <strong className="text-fg-muted">{t('landing.pricing.yearlyDiscount')}:</strong> {t('landing.pricing.yearlyNote', { pct: priceBook.yearly_discount_percent })}
          </p>
        </div>
      </div>
    </section>
  );
};

// ─── FAQ ─────────────────────────────────────────────────────────────────────

const FAQItem: React.FC<{ q: string; a: string }> = ({ q, a }) => {
  const [open, setOpen] = useState(false);
  return (
    <div onClick={() => setOpen(!open)} className={cn(
      'glass-card cursor-pointer overflow-hidden rounded-tile transition-[border-color,background-color] duration-200',
      open ? 'border-brand/30' : '',
    )}>
      <div className="flex items-center justify-between gap-4 px-[22px] py-[18px]">
        <span className="text-sm font-semibold text-fg">{q}</span>
        <ChevronDown size={16} className={cn('shrink-0 text-fg-subtle transition-transform duration-200', open ? 'rotate-180' : '')} />
      </div>
      {open && (
        <div className="px-[22px] pb-[18px]">
          <p className="m-0 text-[13px] leading-[1.7] text-fg-muted">{a}</p>
        </div>
      )}
    </div>
  );
};

// ─── Main page ────────────────────────────────────────────────────────────────

const LandingPage: React.FC = () => {
  const { t } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', fn, { passive: true });
    return () => window.removeEventListener('scroll', fn);
  }, []);

  const navLinks = [
    { href: '#features', label: t('landing.nav.features') },
    { href: '#screenshots', label: t('landing.nav.insights') },
    { href: '#pricing', label: t('landing.nav.pricing') },
    { href: '#faq', label: t('landing.nav.faq') },
  ];

  return (
    <div className="min-h-dvh overflow-x-hidden font-ui text-fg">

      {/* ── Navbar ── */}
      <header className={cn(
        'fixed inset-x-0 top-0 z-50 transition-colors duration-300',
        scrolled ? 'glass-topbar' : 'border-b border-transparent',
      )}>
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-4 md:px-6">
          {/* The mark and the wordmark each come in a pair, one per theme. The
              wordmark carries the name beside it, so the mark is decorative. */}
          <span className="flex items-center gap-2.5">
            <BrandLogo className="h-[30px] w-auto object-contain" />
            <img src="/brand/wordmark-on-light.png" alt="El-Professor" className="h-[17px] w-auto object-contain dark:hidden" />
            <img src="/brand/wordmark-on-dark.png" alt="El-Professor" className="hidden h-[17px] w-auto object-contain dark:block" />
          </span>

          <nav className="hidden items-center gap-7 md:flex">
            {navLinks.map(l => (
              <a key={l.href} href={l.href} className="text-[13px] text-fg-muted transition-colors duration-200 hover:text-fg">{l.label}</a>
            ))}
          </nav>

          <div className="hidden items-center gap-3 md:flex">
            <Button asChild variant="ghost">
              <Link to="/login">{t('auth.signIn')}</Link>
            </Button>
            <Button asChild>
              <Link to="/signup">{t('landing.nav.tryFree')}</Link>
            </Button>
          </div>

          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(!mobileOpen)}>
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </Button>
        </div>

        {mobileOpen && (
          <div className="glass-strong rounded-none border-x-0 border-t-0 px-6 pb-5 pt-4">
            {navLinks.map(l => (
              <a key={l.href} href={l.href} onClick={() => setMobileOpen(false)} className="block border-b border-line py-2.5 text-sm text-fg-muted [@media(pointer:coarse)]:py-3.5">{l.label}</a>
            ))}
            <Button asChild variant="secondary" size="lg" className="mt-3.5 w-full">
              <Link to="/login" onClick={() => setMobileOpen(false)}>
                {t('auth.signIn')}
              </Link>
            </Button>
            <Button asChild size="lg" className="mt-2.5 w-full">
              <Link to="/signup" onClick={() => setMobileOpen(false)}>
                {t('landing.nav.tryFree')}
              </Link>
            </Button>
          </div>
        )}
      </header>

      {/* ── Hero ── */}
      <section className={cn(SECTION_SPACING, 'px-4 pb-16 pt-[104px] md:px-5 md:pb-[100px] md:pt-[120px]')}>
        <div className="mx-auto max-w-[1200px]">
          <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16">

            {/* Left */}
            <div className="min-w-0 max-w-[540px]">
              <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-brand/20 bg-brand-soft px-3.5 py-1.5 text-[11px] font-bold tracking-[0.06em] text-brand-text rtl:tracking-normal">
                <span className="size-1.5 rounded-full bg-positive-dot motion-safe:animate-pulse" />
                {t('landing.hero.badge')}
              </div>

              <h1 className="mb-6 text-[length:clamp(32px,5vw,68px)] font-semibold leading-none tracking-[-0.03em] rtl:tracking-normal max-lg:break-words max-lg:[hyphens:auto]">
                {t('landing.hero.titleLead')}<br />
                <GradientText>{t('landing.hero.titleHighlight')}</GradientText><br />
                {t('landing.hero.titleTail')}
              </h1>

              <p className="mb-9 max-w-[440px] text-base leading-[1.65] text-fg-muted">
                {t('landing.hero.subtitle')}
              </p>

              <div className="mb-10 flex flex-wrap gap-3">
                <Button asChild size="lg">
                  <Link to="/signup">
                    {t('landing.hero.ctaPrimary')} <ArrowRight size={15} className="rtl:-scale-x-100" />
                  </Link>
                </Button>
                <Button asChild variant="secondary" size="lg">
                  <a href="#features">
                    {t('landing.hero.ctaSecondary')}
                  </a>
                </Button>
              </div>

              <div className="flex flex-wrap gap-5">
                {[t('landing.hero.noCreditCard'), t('landing.trust.gdpr'), t('landing.trust.madeInGermany')].map((badge, i) => (
                  <span key={i} className="flex items-center gap-1.5 text-xs text-fg-subtle">
                    <CheckCircle size={12} className="text-positive" /> {badge}
                  </span>
                ))}
              </div>
            </div>

            {/* Right: dashboard */}
            <div className="relative">
              <HeroDashboard />
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats strip ── */}
      <section className={cn(SECTION_SPACING, 'px-4 md:px-5')}>
        <div className="glass-card mx-auto max-w-[1000px] rounded-surface px-5 py-6 md:px-10 md:py-8">
          <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
            {[
              { v: '500+', l: t('landing.stats.bookings') },
              { v: '98%', l: t('landing.stats.satisfaction') },
              { v: t('landing.stats.timeSavedValue'), l: t('landing.stats.timeSaved') },
              { v: '99.9%', l: t('landing.stats.uptime') },
            ].map((s, i) => (
              <div key={i} className="text-center">
                <div className="mb-1.5 text-[28px] font-semibold tabular-nums tracking-[-0.03em] text-brand-text rtl:tracking-normal">{s.v}</div>
                <div className="text-xs text-fg-subtle">{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pain section ── */}
      <section className={cn(SECTION_SPACING, SECTION_PAD)}>
        <div className="mx-auto max-w-[1100px]">
          <div className={SECTION_HEAD}>
            <Tag>{t('landing.pain.tag')}</Tag>
            <h2 className={H2_CLASS}>
              {t('landing.pain.titleLead')} <GradientText>{t('landing.pain.titleHighlight')}</GradientText>
            </h2>
            <p className={BODY_CLASS}>{t('landing.pain.body')}</p>
          </div>

          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <PainCard value="90%" label={t('landing.pain.time.label')} desc={t('landing.pain.time.desc')} accent="brand" />
            <PainCard value="0" label={t('landing.pain.payrollErrors.label')} desc={t('landing.pain.payrollErrors.desc')} accent="violet" />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <PainCard value="100%" label={t('landing.pain.fleet.label')} desc={t('landing.pain.fleet.desc')} accent="positive" />
            <PainCard value="1" label={t('landing.pain.onePlatform.label')} desc={t('landing.pain.onePlatform.desc')} accent="info" />
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" className={cn(SECTION_SPACING, SECTION_PAD)}>
        <div className="mx-auto max-w-[1100px]">
          <div className={SECTION_HEAD}>
            <Tag>{t('landing.features.tag')}</Tag>
            <h2 className={H2_CLASS}>
              {t('landing.features.titleLead')} <GradientText>{t('landing.features.titleHighlight')}</GradientText>
            </h2>
            <p className={BODY_CLASS}>{t('landing.features.body')}</p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { icon: <TrendingUp size={18}/>, title: t('landing.feature.revenue.title'), desc: t('landing.feature.revenue.desc'), accent: 'brand' },
              { icon: <FileText size={18}/>, title: t('landing.feature.belege.title'), desc: t('landing.feature.belege.desc'), accent: 'violet' },
              { icon: <Users size={18}/>, title: t('landing.feature.drivers.title'), desc: t('landing.feature.drivers.desc'), accent: 'teal' },
              { icon: <DollarSign size={18}/>, title: t('landing.feature.payroll.title'), desc: t('landing.feature.payroll.desc'), accent: 'caution' },
              { icon: <Wallet size={18}/>, title: t('nav.bargeldbestand'), desc: t('landing.feature.cash.desc'), accent: 'positive' },
              { icon: <BarChart3 size={18}/>, title: t('landing.feature.abrechnung.title'), desc: t('landing.feature.abrechnung.desc'), accent: 'info' },
              { icon: <Car size={18}/>, title: t('landing.feature.fleet.title'), desc: t('landing.feature.fleet.desc'), accent: 'violet' },
              { icon: <Wrench size={18}/>, title: t('landing.feature.werkstatt.title'), desc: t('landing.feature.werkstatt.desc'), accent: 'caution' },
              { icon: <Target size={18}/>, title: t('landing.feature.dashboard.title'), desc: t('landing.feature.dashboard.desc'), accent: 'brand' },
              { icon: <Receipt size={18}/>, title: t('nav.documents'), desc: t('landing.feature.documents.desc'), accent: 'positive' },
              { icon: <Settings size={18}/>, title: t('locked.feature.rollenNutzer'), desc: t('landing.feature.roles.desc'), accent: 'info' },
              { icon: <CreditCard size={18}/>, title: t('nav.fixkosten'), desc: t('landing.feature.fixedCosts.desc'), accent: 'teal' },
            ].map((f, i) => (
              <FeatureCard key={i} {...f} />
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="workflow" className={cn(SECTION_SPACING, SECTION_PAD)}>
        <div className="mx-auto max-w-[1100px]">
          <div className="mb-16 text-center">
            <Tag>{t('landing.how.tag')}</Tag>
            <h2 className={H2_CLASS}>{t('landing.how.titleLead')} <GradientText>{t('landing.how.titleHighlight')}</GradientText></h2>
            <p className={BODY_CLASS}>{t('landing.how.body')}</p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              { n: '01', title: t('landing.how.step1.title'), desc: t('landing.how.step1.desc') },
              { n: '02', title: t('landing.how.step2.title'), desc: t('landing.how.step2.desc') },
              { n: '03', title: t('landing.how.step3.title'), desc: t('landing.how.step3.desc') },
            ].map((s, i) => (
              <div
                key={i}
                className="glass-card group relative cursor-default overflow-hidden rounded-surface px-6 py-7 transition-[border-color,box-shadow] duration-300 hover:border-brand/30 hover:shadow-brand"
              >
                <div className="absolute inset-x-0 top-0 h-0.5 bg-brand opacity-50 transition-opacity duration-300 group-hover:opacity-75" />
                <div className="mb-3.5 text-[40px] font-semibold leading-none tracking-[-0.04em] text-fg-subtle/40 transition-colors duration-300 group-hover:text-brand-text rtl:tracking-normal">{s.n}</div>
                <div className="mb-2.5 text-[15px] font-semibold text-fg">{s.title}</div>
                <div className="text-[13px] leading-[1.65] text-fg-muted">{s.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Product screenshots ── */}
      <section id="screenshots" className={cn(SECTION_SPACING, SECTION_PAD)}>
        <div className="mx-auto max-w-[1100px]">
          <div className={SECTION_HEAD}>
            <Tag>{t('landing.nav.insights')}</Tag>
            <h2 className={H2_CLASS}>
              {t('landing.screens.titleLead')}<br /><GradientText>{t('landing.screens.titleHighlight')}</GradientText>
            </h2>
            <p className={BODY_CLASS}>{t('landing.screens.body')}</p>
          </div>

          {/* Row 1 */}
          <div className="mb-5 grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <div className="mb-5">
                <div className="mb-1.5 text-base font-semibold text-fg">{t('landing.screens.payout.title')}</div>
                <div className="mb-4 text-[13px] leading-[1.65] text-fg-muted">{t('landing.screens.payout.body')}</div>
                {[t('landing.screens.payout.point1'),t('landing.screens.payout.point2'),t('landing.screens.payout.point3'),t('landing.screens.payout.point4')].map((f,i) => (
                  <div key={i} className={CHECK_ROW}>
                    <CheckCircle size={12} className="shrink-0 text-brand-text" /> {f}
                  </div>
                ))}
              </div>
            </div>
            <AbrechnungPanel />
          </div>

          {/* Row 2 */}
          <div className="mb-5 grid grid-cols-1 gap-5 md:grid-cols-2">
            <KassePanel />
            <div className="order-first flex flex-col justify-center md:order-none">
              <div className="mb-1.5 text-base font-semibold text-fg">{t('landing.screens.cash.title')}</div>
              <div className="mb-4 text-[13px] leading-[1.65] text-fg-muted">{t('landing.screens.cash.body')}</div>
              {[t('landing.screens.cash.point1'),t('landing.screens.cash.point2'),t('landing.screens.cash.point3'),t('landing.screens.cash.point4')].map((f,i) => (
                <div key={i} className={CHECK_ROW}>
                  <CheckCircle size={12} className="shrink-0 text-violet" /> {f}
                </div>
              ))}
            </div>
          </div>

          {/* Row 3 */}
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="flex flex-col justify-center">
              <div className="mb-1.5 text-base font-semibold text-fg">{t('landing.screens.fleet.title')}</div>
              <div className="mb-4 text-[13px] leading-[1.65] text-fg-muted">{t('landing.screens.fleet.body')}</div>
              {[t('landing.screens.fleet.point1'),t('landing.screens.fleet.point2'),t('landing.screens.fleet.point3'),t('landing.screens.fleet.point4')].map((f,i) => (
                <div key={i} className={CHECK_ROW}>
                  <CheckCircle size={12} className="shrink-0 text-caution" /> {f}
                </div>
              ))}
            </div>
            <FuhrparkPanel />
          </div>
        </div>
      </section>

      {/* ── Trust strip ── */}
      <section className={cn(SECTION_SPACING, 'px-4 pb-16 md:px-5 md:pb-20')}>
        <div className="mx-auto max-w-[1000px]">
          <div className="glass-card grid grid-cols-1 gap-4 rounded-surface px-5 py-5 sm:grid-cols-2 md:px-10 md:py-6 lg:grid-cols-4 lg:gap-5">
            {[
              { icon: <Shield size={16} className="text-positive" />, label: t('landing.trust.gdpr'), sub: t('landing.trust.gdprSub') },
              { icon: <Zap size={16} className="text-brand-text" />, label: t('landing.trust.realtime.label'), sub: t('landing.trust.realtime.sub') },
              { icon: <Globe size={16} className="text-violet" />, label: t('landing.trust.anywhere.label'), sub: t('landing.trust.anywhere.sub') },
              { icon: <Clock size={16} className="text-caution" />, label: t('landing.trust.support.label'), sub: t('landing.trust.support.sub') },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-control border border-line bg-sunken">
                  {item.icon}
                </div>
                <div>
                  <div className="text-xs font-bold text-fg">{item.label}</div>
                  <div className="text-[11px] text-fg-subtle">{item.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ── */}
      <PricingSection />

      {/* ── Testimonials ── */}
      <section className={cn(SECTION_SPACING, SECTION_PAD_COMPACT)}>
        <div className="mx-auto max-w-[1100px]">
          <div className="mb-12 text-center">
            <Tag>{t('landing.testimonials.tag')}</Tag>
            <h2 className={cn(H2_BASE, 'text-[length:clamp(28px,3vw,42px)]')}>{t('landing.testimonials.title')}</h2>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              { name: 'Mehmet A.', role: t('landing.testimonials.role1'), quote: t('landing.testimonials.quote1') },
              { name: 'Klaus T.', role: t('landing.testimonials.role2'), quote: t('landing.testimonials.quote2') },
              { name: 'Ahmad S.', role: t('landing.testimonials.role3'), quote: t('landing.testimonials.quote3') },
            ].map((testimonial, i) => (
              <div key={i} className="glass-card rounded-surface px-[22px] py-6 transition-[border-color] duration-200 hover:border-line-strong">
                <div className="mb-3.5 flex gap-0.5">
                  {Array(5).fill(0).map((_,j) => <Star key={j} size={13} className="fill-caution-dot text-caution-dot" />)}
                </div>
                <p className="mb-[18px] text-[13px] italic leading-[1.7] text-fg-muted">"{testimonial.quote}"</p>
                <div className="flex items-center gap-2.5">
                  <div className="flex size-8 items-center justify-center rounded-full bg-brand-gradient text-xs font-extrabold text-brand-fg">
                    {testimonial.name.charAt(0)}
                  </div>
                  <div>
                    <div className="text-[13px] font-bold text-fg">{testimonial.name}</div>
                    <div className="text-[11px] text-fg-subtle">{testimonial.role}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className={cn(SECTION_SPACING, SECTION_PAD)}>
        <div className="mx-auto max-w-[720px]">
          <div className="mb-14 text-center">
            <Tag>{t('landing.nav.faq')}</Tag>
            <h2 className={H2_CLASS}>{t('landing.faq.titleLead')} <GradientText>{t('landing.faq.titleHighlight')}</GradientText></h2>
          </div>
          <div className="flex flex-col gap-2.5">
            {[
              { q: t('landing.faq.q.startSpeed'), a: t('landing.faq.a.startSpeed') },
              { q: t('landing.faq.q.dataImport'), a: t('landing.faq.a.dataImport') },
              { q: t('landing.faq.q.payroll'), a: t('landing.faq.a.payroll') },
              { q: t('landing.faq.q.gdpr'), a: t('landing.faq.a.gdpr') },
              { q: t('landing.faq.q.multipleUsers'), a: t('landing.faq.a.multipleUsers') },
              { q: t('landing.faq.q.minimumTerm'), a: t('landing.faq.a.minimumTerm') },
            ].map((item, i) => (
              <FAQItem key={i} q={item.q} a={item.a} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className={cn(SECTION_SPACING, SECTION_PAD_COMPACT)}>
        <div className="relative mx-auto max-w-[860px]">
          {/* Glow */}
          <div className="pointer-events-none absolute inset-0 bg-brand/10 blur-[40px]" />

          <div className="glass-sheet relative overflow-hidden rounded-pane px-5 py-12 text-center md:px-12 md:py-[72px]">
            {/* Top glow line */}
            <div className="absolute inset-x-[20%] top-0 h-px bg-gradient-to-r from-transparent via-brand to-transparent" />

            <Tag>{t('landing.cta.tag')}</Tag>
            <h2 className={cn(H2_CLASS, 'mb-4')}>
              {t('landing.cta.titleLead')}<br /><GradientText>{t('landing.cta.titleHighlight')}</GradientText>
            </h2>
            <p className={cn(BODY_CLASS, 'mx-auto mb-9 max-w-[440px]')}>
              {t('landing.cta.body')}
            </p>
            <div className="flex flex-wrap justify-center gap-3.5">
              <Button asChild size="lg">
                <Link to="/signup">
                  {t('landing.cta.primary')} <ArrowRight size={15} className="rtl:-scale-x-100" />
                </Link>
              </Button>
              <Button asChild variant="secondary" size="lg">
                <a href="#features">
                  {t('landing.cta.secondary')}
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="relative z-10 border-t border-line px-6 pb-8 pt-12">
        <div className="mx-auto max-w-[1200px]">
          <div className="mb-10 grid grid-cols-2 gap-x-6 gap-y-8 md:mb-12 md:grid-cols-[2fr_1fr_1fr_1fr] md:gap-10">
            <div className="col-span-2 md:col-span-1">
              <span className="mb-3.5 flex items-center gap-2 opacity-80">
                <BrandLogo className="h-7 w-auto object-contain" />
                <img src="/brand/wordmark-on-light.png" alt="El-Professor" className="h-4 w-auto object-contain dark:hidden" />
                <img src="/brand/wordmark-on-dark.png" alt="El-Professor" className="hidden h-4 w-auto object-contain dark:block" />
              </span>
              <p className="max-w-[260px] text-[13px] leading-[1.65] text-fg-subtle">
                {t('landing.footer.tagline')}
              </p>
            </div>
            {[
              { head: t('landing.footer.product'), links: [{ l: t('landing.nav.features'), h: '#features' }, { l: t('landing.nav.insights'), h: '#screenshots' }, { l: t('landing.nav.pricing'), h: '#pricing' }] },
              { head: t('landing.footer.company'), links: [{ l: t('landing.nav.faq'), h: '#faq' }, { l: t('landing.footer.support'), h: '#faq' }, { l: t('legal.link.impressum'), h: LEGAL_PATHS.impressum }, { l: t('legal.link.privacy'), h: LEGAL_PATHS.privacy }] },
              { head: t('landing.footer.access'), links: [{ l: t('auth.signIn'), h: '/login' }, { l: t('landing.nav.tryFree'), h: '/login' }] },
            ].map((col, i) => (
              <div key={i}>
                <div className="mb-4 text-[11px] font-extrabold uppercase tracking-[0.1em] text-fg-subtle rtl:tracking-normal">{col.head}</div>
                <div className="flex flex-col gap-2.5">
                  {col.links.map((lk, j) => (
                    <a key={j} href={lk.h} className="text-[13px] text-fg-muted transition-colors duration-200 hover:text-fg [@media(pointer:coarse)]:py-1">{lk.l}</a>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6">
            <p className="text-xs text-fg-subtle">© {new Date().getFullYear()} El-Professor. {t('landing.footer.rights')}</p>
            <p className="text-xs text-fg-subtle">{t('landing.trust.gdpr')} · {t('landing.trust.madeInGermany')}</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
