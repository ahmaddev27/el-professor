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

// ─── Design tokens ────────────────────────────────────────────────────────────

const BG      = '#07090f';
const SURFACE = '#0d1117';
const CARD    = '#0f1520';
const BORDER  = 'rgba(255,255,255,0.07)';

// ─── Shared primitives ────────────────────────────────────────────────────────

const GradientText: React.FC<{ children: React.ReactNode; violet?: boolean }> = ({ children, violet }) => (
  <span style={{
    background: violet
      ? 'linear-gradient(90deg, #818cf8 0%, #06b6d4 100%)'
      : 'linear-gradient(90deg, #06b6d4 0%, #818cf8 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundClip: 'text',
  }}>
    {children}
  </span>
);

const Tag: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{
    display: 'inline-block',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: '#06b6d4',
    marginBottom: '16px',
  }}>
    {children}
  </span>
);

// ─── Animated glow orbs ───────────────────────────────────────────────────────

const BgOrbs: React.FC = () => (
  <div style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
    {/* Grid */}
    <div style={{
      position: 'absolute', inset: 0,
      backgroundImage: 'linear-gradient(rgba(6,182,212,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(6,182,212,0.025) 1px, transparent 1px)',
      backgroundSize: '52px 52px',
    }} />
    <div style={{ position: 'absolute', top: '-10%', left: '20%', width: 700, height: 700, background: 'radial-gradient(circle, rgba(6,182,212,0.06) 0%, transparent 70%)', borderRadius: '50%', filter: 'blur(40px)' }} />
    <div style={{ position: 'absolute', top: '30%', right: '10%', width: 500, height: 500, background: 'radial-gradient(circle, rgba(129,140,248,0.07) 0%, transparent 70%)', borderRadius: '50%', filter: 'blur(40px)' }} />
    <div style={{ position: 'absolute', bottom: '20%', left: '10%', width: 600, height: 600, background: 'radial-gradient(circle, rgba(6,182,212,0.04) 0%, transparent 70%)', borderRadius: '50%', filter: 'blur(60px)' }} />
  </div>
);

// ─── Mini charts ─────────────────────────────────────────────────────────────

const BarChart: React.FC = () => {
  const bars = [40, 58, 45, 70, 62, 85, 68, 90, 75, 96, 80, 100];
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 40 }}>
      {bars.map((h, i) => (
        <div key={i} style={{
          flex: 1, height: `${h}%`, borderRadius: 2,
          background: i >= bars.length - 3
            ? 'linear-gradient(to top, #06b6d4, #818cf8)'
            : `rgba(6,182,212,${0.15 + (i / bars.length) * 0.3})`,
        }} />
      ))}
    </div>
  );
};

const LineChart: React.FC = () => {
  const pts = [18, 28, 22, 42, 36, 55, 48, 66, 58, 74, 68, 88];
  const W = 130, H = 44, max = 88;
  const d = pts.map((v, i) => `${(i / (pts.length - 1)) * W},${H - (v / max) * H}`).join(' ');
  return (
    <svg width={W} height={H} style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id="ll" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#06b6d4" />
          <stop offset="100%" stopColor="#818cf8" />
        </linearGradient>
        <linearGradient id="lf" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#06b6d4" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${d} ${W},${H}`} fill="url(#lf)" />
      <polyline points={d} fill="none" stroke="url(#ll)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

const RingChart: React.FC<{ pct: number; size?: number }> = ({ pct, size = 44 }) => {
  const r = size / 2 - 5, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="url(#rg)" strokeWidth="4"
        strokeDasharray={`${(pct/100)*c} ${c}`} strokeLinecap="round" />
      <defs>
        <linearGradient id="rg" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#06b6d4" />
          <stop offset="100%" stopColor="#818cf8" />
        </linearGradient>
      </defs>
    </svg>
  );
};

// ─── Hero dashboard mockup ────────────────────────────────────────────────────

const HeroDashboard: React.FC = () => {
  const { t } = useTranslation();
  return (
  <div style={{ position: 'relative', width: '100%', maxWidth: 600, margin: '0 auto' }}>
    {/* Glow halo */}
    <div style={{
      position: 'absolute', inset: '-20%', borderRadius: '50%',
      background: 'radial-gradient(ellipse, rgba(6,182,212,0.12) 0%, rgba(129,140,248,0.08) 40%, transparent 70%)',
      filter: 'blur(30px)', pointerEvents: 'none',
    }} />

    {/* Main panel */}
    <div style={{
      position: 'relative',
      background: 'linear-gradient(145deg, #111827 0%, #0a0f1a 100%)',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 20,
      overflow: 'hidden',
      boxShadow: '0 40px 100px rgba(0,0,0,0.7), 0 0 0 1px rgba(6,182,212,0.08)',
    }}>
      {/* Window chrome */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgba(239,68,68,0.5)' }} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgba(245,158,11,0.5)' }} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgba(16,185,129,0.5)' }} />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', fontFamily: 'monospace' }}>El-Professor · Dashboard</span>
      </div>

      <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
          {[
            { l: t('landing.mock.kpiRevenue'), v: '28.450 €', d: '+12.4%', pos: true },
            { l: t('landing.mock.kpiProfit'), v: '8.720 €', d: '+8.1%', pos: true },
            { l: t('nav.fahrer'), v: t('landing.mock.kpiDriversValue'), d: null, pos: true },
          ].map((k, i) => (
            <div key={i} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '10px 12px' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>{k.l}</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: '#fff' }}>{k.v}</div>
              {k.d && <div style={{ fontSize: 9, fontWeight: 700, color: k.pos ? '#34d399' : '#f87171', marginTop: 2 }}>{k.d}</div>}
            </div>
          ))}
        </div>

        {/* Chart */}
        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.6)' }}>{t('landing.mock.trendTitle')}</div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)' }}>{t('landing.mock.trendSub')}</div>
            </div>
            <span style={{ fontSize: 9, fontWeight: 700, color: '#34d399', background: 'rgba(52,211,153,0.1)', padding: '2px 8px', borderRadius: 100 }}>+12.4%</span>
          </div>
          <BarChart />
        </div>

        {/* Bottom panels */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: '10px 12px' }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{t('landing.mock.incomeMix')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <RingChart pct={68} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[['#06b6d4',t('landing.mock.legendFare')],['#818cf8',t('landing.mock.legendCash')],['#f472b6',t('landing.mock.legendTip')]].map(([c,l],i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9, color: 'rgba(255,255,255,0.55)' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: c as string, flexShrink: 0 }} />
                    {l}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: '10px 12px' }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{t('landing.mock.topDrivers')}</div>
            {['Ahmad K.','Klaus M.','Mehmet A.'].map((n,i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 9, fontWeight: 800, color: 'rgba(255,255,255,0.2)', width: 10 }}>{i+1}</span>
                <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 100, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${88 - i*18}%`, background: 'linear-gradient(90deg,#06b6d4,#818cf8)', borderRadius: 100 }} />
                </div>
                <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', width: 50, overflow: 'hidden', whiteSpace: 'nowrap' }}>{n}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Alert bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.18)', borderRadius: 10 }}>
          <AlertTriangle size={11} style={{ color: '#fbbf24', flexShrink: 0 }} />
          <span style={{ fontSize: 9, color: 'rgba(251,191,36,0.8)' }}>{t('landing.mock.alert')}</span>
          <span style={{ marginLeft: 'auto', fontSize: 9, color: '#fbbf24', fontWeight: 700 }}>{t('landing.mock.alertAction')}</span>
        </div>
      </div>
    </div>

    {/* Floating card 1 — Bargeld */}
    <div
      className="hidden lg:block hero-float-card-1"
      style={{
        position: 'absolute', top: 80, left: -60, width: 148,
        background: 'rgba(13,17,23,0.92)', backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.11)', borderRadius: 14,
        padding: '12px 14px',
        boxShadow: '0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(6,182,212,0.06)',
        cursor: 'default',
        transition: 'box-shadow 0.3s ease, border-color 0.3s ease, transform 0.3s ease',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = '0 24px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(6,182,212,0.25), 0 0 32px rgba(6,182,212,0.12)';
        el.style.borderColor = 'rgba(6,182,212,0.25)';
        el.style.transform = 'rotate(-4deg) translateY(-4px) scale(1.04)';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = '0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(6,182,212,0.06)';
        el.style.borderColor = 'rgba(255,255,255,0.11)';
        el.style.transform = '';
      }}
    >
      <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{t('landing.mock.cashLabel')}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>3.920 €</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, fontWeight: 700, color: '#34d399', marginTop: 3 }}>
        <TrendingUp size={8} /> {t('landing.mock.cashDelta')}
      </div>
      <span style={{
        position: 'absolute', top: 8, right: 8, width: 6, height: 6, borderRadius: '50%',
        background: '#06b6d4',
        boxShadow: '0 0 8px rgba(6,182,212,0.8)',
        animation: 'dot-pulse 2s ease-in-out infinite',
      }} />
    </div>

    {/* Floating card 2 — Flotte */}
    <div
      className="hidden lg:block hero-float-card-2"
      style={{
        position: 'absolute', top: 100, right: -28, width: 142,
        background: 'rgba(13,17,23,0.92)', backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.11)', borderRadius: 14,
        padding: '12px 14px',
        boxShadow: '0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(129,140,248,0.06)',
        cursor: 'default',
        transition: 'box-shadow 0.3s ease, border-color 0.3s ease, transform 0.3s ease',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = '0 24px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(129,140,248,0.28), 0 0 32px rgba(129,140,248,0.12)';
        el.style.borderColor = 'rgba(129,140,248,0.28)';
        el.style.transform = 'rotate(3deg) translateY(-4px) scale(1.04)';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = '0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(129,140,248,0.06)';
        el.style.borderColor = 'rgba(255,255,255,0.11)';
        el.style.transform = '';
      }}
    >
      <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{t('landing.mock.fleetLabel')}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>8 / 9 OK</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, fontWeight: 700, color: '#34d399', marginTop: 3 }}>
        <Car size={8} /> {t('landing.mock.fleetAllActive')}
      </div>
      <span style={{
        position: 'absolute', top: 8, right: 8, width: 6, height: 6, borderRadius: '50%',
        background: '#818cf8',
        boxShadow: '0 0 8px rgba(129,140,248,0.8)',
        animation: 'dot-pulse 2.4s ease-in-out 0.6s infinite',
      }} />
    </div>

    {/* Floating card 3 — Gewinnmarge */}
    <div
      className="hidden lg:block hero-float-card-3"
      style={{
        position: 'absolute', bottom: 80, right: -28, width: 148,
        background: 'rgba(13,17,23,0.92)', backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.11)', borderRadius: 14,
        padding: '12px 14px',
        boxShadow: '0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(244,114,182,0.06)',
        cursor: 'default',
        transition: 'box-shadow 0.3s ease, border-color 0.3s ease, transform 0.3s ease',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = '0 24px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(244,114,182,0.28), 0 0 32px rgba(244,114,182,0.1)';
        el.style.borderColor = 'rgba(244,114,182,0.28)';
        el.style.transform = 'rotate(-2deg) translateY(-4px) scale(1.04)';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.boxShadow = '0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(244,114,182,0.06)';
        el.style.borderColor = 'rgba(255,255,255,0.11)';
        el.style.transform = '';
      }}
    >
      <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{t('landing.mock.marginLabel')}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>30.6%</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, fontWeight: 700, color: '#34d399', marginTop: 3 }}>
        <TrendingUp size={8} /> +2.1pp
      </div>
      <span style={{
        position: 'absolute', top: 8, right: 8, width: 6, height: 6, borderRadius: '50%',
        background: '#f472b6',
        boxShadow: '0 0 8px rgba(244,114,182,0.8)',
        animation: 'dot-pulse 2.8s ease-in-out 1.1s infinite',
      }} />
    </div>
  </div>
  );
};

// ─── Pain stat card ───────────────────────────────────────────────────────────

const PainCard: React.FC<{ value: string; label: string; desc: string; accent: string }> = ({ value, label, desc, accent }) => (
  <div style={{
    background: CARD,
    border: `1px solid ${BORDER}`,
    borderRadius: 16,
    padding: '28px 24px',
    position: 'relative',
    overflow: 'hidden',
  }}>
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: accent }} />
    <div style={{ fontSize: 40, fontWeight: 900, letterSpacing: '-0.03em', marginBottom: 4,
      background: accent, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
      {value}
    </div>
    <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.8)', marginBottom: 6 }}>{label}</div>
    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.38)', lineHeight: 1.6 }}>{desc}</div>
  </div>
);

// ─── Feature card ─────────────────────────────────────────────────────────────

/**
 * The prop is `accent`, as on `PainCard` above, because that is the key the
 * twelve card literals below pass through `{...f}`. It was `accentColor`, so
 * every one of the twelve rendered `background: 'undefined18'`, a border of
 * `'undefined30'`, a hover border of `'undefined33'` and an undefined icon
 * colour — on the product's own front page, on every visit. Renaming the prop
 * rather than the twelve literals keeps the data untouched and keeps the two
 * card components naming the same thing the same way.
 */
const FeatureCard: React.FC<{
  icon: React.ReactNode; title: string; desc: string; accent: string;
}> = ({ icon, title, desc, accent }) => (
  <div style={{
    background: CARD,
    border: `1px solid ${BORDER}`,
    borderRadius: 14,
    padding: '22px 20px',
    cursor: 'default',
    transition: 'border-color 0.3s, background 0.3s',
  }}
    onMouseEnter={e => {
      (e.currentTarget as HTMLElement).style.borderColor = `${accent}33`;
      (e.currentTarget as HTMLElement).style.background = '#121c2d';
    }}
    onMouseLeave={e => {
      (e.currentTarget as HTMLElement).style.borderColor = BORDER;
      (e.currentTarget as HTMLElement).style.background = CARD;
    }}
  >
    <div style={{
      width: 40, height: 40, borderRadius: 10,
      background: `${accent}18`,
      border: `1px solid ${accent}30`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      marginBottom: 14, color: accent,
    }}>
      {icon}
    </div>
    <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.9)', marginBottom: 6 }}>{title}</div>
    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', lineHeight: 1.65 }}>{desc}</div>
  </div>
);

// ─── Screenshot panel ─────────────────────────────────────────────────────────

const ScreenPanel: React.FC<{ title: string; subtitle: string; children: React.ReactNode; tag?: string }> = ({ title, subtitle, children, tag }) => (
  <div style={{ background: 'rgba(13,17,23,0.8)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 18, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.55)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'rgba(239,68,68,0.45)' }} />
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'rgba(245,158,11,0.45)' }} />
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'rgba(16,185,129,0.45)' }} />
      <span style={{ flex: 1 }} />
      {tag && <span style={{ fontSize: 9, color: '#06b6d4', fontWeight: 700, background: 'rgba(6,182,212,0.1)', padding: '2px 8px', borderRadius: 100 }}>{tag}</span>}
    </div>
    <div style={{ padding: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.85)', marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginBottom: 14 }}>{subtitle}</div>
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
      { name: 'Ahmad K.', umsatz: '2.840 €', lohn: '1.136 €', status: t('landing.mock.statusPaid'), color: '#34d399' },
      { name: 'Klaus M.', umsatz: '2.290 €', lohn: '916 €', status: t('landing.mock.statusOpen'), color: '#fbbf24' },
      { name: 'Mehmet A.', umsatz: '3.110 €', lohn: '1.244 €', status: t('landing.mock.statusPaid'), color: '#34d399' },
      { name: 'Stefan B.', umsatz: '1.960 €', lohn: '784 €', status: t('landing.mock.statusOpen'), color: '#fbbf24' },
    ].map((r, i) => (
      <div key={i} style={{ display: 'flex', alignItems: 'center', padding: '8px 0', borderBottom: i < 3 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
        <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'linear-gradient(135deg,#06b6d4,#818cf8)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 800, color: '#fff', marginRight: 10, flexShrink: 0 }}>
          {r.name.charAt(0)}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.8)' }}>{r.name}</div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>{t('landing.mock.kpiRevenue')} {r.umsatz}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: '#fff' }}>{r.lohn}</div>
          <div style={{ fontSize: 9, fontWeight: 700, color: r.color }}>{r.status}</div>
        </div>
      </div>
    ))}
    <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{t('landing.mock.totalOpen')}</span>
      <span style={{ fontSize: 14, fontWeight: 900, color: '#06b6d4' }}>1.700 €</span>
    </div>
  </ScreenPanel>
  );
};

// ─── Kasse mockup ─────────────────────────────────────────────────────────────

const KassePanel: React.FC = () => {
  const { t } = useTranslation();
  return (
  <ScreenPanel title={t('landing.mock.kasseTitle')} subtitle={t('landing.mock.kasseSub')}>
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{t('landing.mock.currentBalance')}</div>
      <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: '-0.03em', background: 'linear-gradient(90deg,#06b6d4,#818cf8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
        4.380 €
      </div>
      <div style={{ fontSize: 10, color: '#34d399', fontWeight: 700, marginTop: 2 }}>{t('landing.mock.vsYesterday')}</div>
    </div>
    <div style={{ marginBottom: 10 }}>
      <LineChart />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {[
        { l: t('landing.mock.incomeToday'), v: '+840 €', c: '#34d399' },
        { l: t('landing.mock.expensesToday'), v: '-520 €', c: '#f87171' },
        { l: t('landing.mock.difference'), v: '+320 €', c: '#06b6d4' },
      ].map((row,i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 8 }}>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>{row.l}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: row.c }}>{row.v}</span>
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
      { kz: 'SG-AB 1234', mod: 'Mercedes Vito', km: '98.400', status: 'OK', c: '#34d399' },
      { kz: 'SG-CD 5678', mod: 'VW Crafter', km: '112.800', status: t('landing.mock.statusInspection'), c: '#fbbf24' },
      { kz: 'SG-EF 9012', mod: 'Ford Transit', km: '76.200', status: 'OK', c: '#34d399' },
      { kz: 'SG-GH 3456', mod: 'Mercedes Vito', km: '154.300', status: 'OK', c: '#34d399' },
    ].map((v, i) => (
      <div key={i} style={{ display: 'flex', alignItems: 'center', padding: '7px 0', borderBottom: i < 3 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 10, flexShrink: 0 }}>
          <Car size={13} style={{ color: 'rgba(255,255,255,0.4)' }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.8)', fontFamily: 'monospace' }}>{v.kz}</div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>{v.mod} · {v.km} km</div>
        </div>
        <span style={{ fontSize: 9, fontWeight: 700, color: v.c, background: `${v.c}18`, padding: '2px 8px', borderRadius: 100 }}>{v.status}</span>
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
  const { priceBook, trialDays } = useAppConfig();
  const [billing, setBilling] = useState<'monthly'|'yearly'>('monthly');
  const [carCount, setCarCount] = useState(5);

  const fleetPct = fleetDiscountPercent(priceBook, carCount);

  return (
    <section id="pricing" style={{ position: 'relative', zIndex: 10 }} className="px-4 py-[72px] md:px-5 md:py-[120px]">
      <div style={{ maxWidth: 1140, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', maxWidth: 560, margin: '0 auto 16px' }}>
          <Tag>{t('landing.nav.pricing')}</Tag>
          <h2 style={{ fontSize: 'clamp(32px,4vw,48px)', fontWeight: 900, lineHeight: 1.1, letterSpacing: '-0.02em', marginBottom: 16 }}>
            {t('landing.pricing.titleLead')} <GradientText violet>{t('landing.pricing.titleHighlight')}</GradientText>
          </h2>
          <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.42)', lineHeight: 1.65 }}>
            {t('landing.pricing.body')}
          </p>
        </div>

        {/* Controls row: billing toggle + car count slider */}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 24, marginBottom: 52 }}>

          {/* Billing toggle */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 100, padding: 4 }}>
            {(['monthly','yearly'] as const).map(b => (
              <button key={b} onClick={() => setBilling(b)} style={{
                padding: '8px 20px', borderRadius: 100, fontSize: 13, fontWeight: 700, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, transition: 'all 0.25s',
                background: billing === b ? 'linear-gradient(90deg,#06b6d4,#818cf8)' : 'transparent',
                color: billing === b ? '#fff' : 'rgba(255,255,255,0.4)',
                boxShadow: billing === b ? '0 2px 16px rgba(6,182,212,0.3)' : 'none',
              }}>
                {b === 'monthly' ? t('landing.pricing.monthly') : (
                  <><span>{t('landing.pricing.yearly')}</span>
                  <span style={{ fontSize: 10, fontWeight: 800, background: billing === 'yearly' ? 'rgba(255,255,255,0.2)' : 'rgba(6,182,212,0.15)', color: billing === 'yearly' ? '#fff' : '#06b6d4', padding: '1px 6px', borderRadius: 100 }}>-{priceBook.yearly_discount_percent}%</span>
                  </>
                )}
              </button>
            ))}
          </div>

          {/* Car count slider */}
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 14 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.35)', whiteSpace: 'nowrap' }}>{t('landing.pricing.vehiclesLabel')}</span>
            <input
              type="range" min={1} max={20} value={carCount}
              onChange={e => setCarCount(Number(e.target.value))}
              style={{ width: 140, accentColor: '#06b6d4', cursor: 'pointer' }}
            />
            <span style={{
              minWidth: 30, textAlign: 'center', fontSize: 15, fontWeight: 800, color: '#fff',
              background: 'rgba(6,182,212,0.1)', border: '1px solid rgba(6,182,212,0.2)',
              borderRadius: 8, padding: '2px 8px',
            }}>{carCount}</span>
            {fleetPct > 0 && (
              <span style={{ fontSize: 11, fontWeight: 700, color: '#34d399', background: 'rgba(52,211,153,0.1)', padding: '2px 8px', borderRadius: 100, whiteSpace: 'nowrap' }}>
                -{fleetPct}% {t('landing.pricing.fleetDiscount')}
              </span>
            )}
          </div>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3" style={{ gap: 20, alignItems: 'center', justifyContent: 'center', justifyItems: 'center', maxWidth: 1080, margin: '0 auto' }}>
          {PRICING_PLANS.map((p) => {
            const bp = calcPricing(priceBook, p.id, carCount, billing);
            const displayMonthly = bp.monthlyEquivalent;
            const displayYearly  = bp.yearlyTotal;
            return (
              <div key={p.id} style={{
                position: 'relative',
                width: '100%', maxWidth: 420,
                borderRadius: 20,
                padding: p.highlight ? '32px 28px' : '28px 24px',
                marginTop: p.highlight ? 0 : 12,
                background: p.highlight
                  ? 'linear-gradient(160deg, #0e1e38 0%, #091528 100%)'
                  : 'linear-gradient(160deg, #0d1523 0%, #070d18 100%)',
                boxShadow: p.highlight
                  ? '0 0 0 1px rgba(6,182,212,0.25), 0 0 80px rgba(6,182,212,0.08), 0 40px 80px rgba(0,0,0,0.6)'
                  : '0 0 0 1px rgba(255,255,255,0.055), 0 24px 56px rgba(0,0,0,0.5)',
                display: 'flex', flexDirection: 'column',
              }}>
                {p.badge && (
                  <div style={{ position: 'absolute', top: -14, left: '50%', transform: 'translateX(-50%)', zIndex: 2 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 800, color: '#fff', padding: '5px 16px', borderRadius: 100, background: 'linear-gradient(90deg,#06b6d4,#818cf8)', boxShadow: '0 0 24px rgba(6,182,212,0.4)', whiteSpace: 'nowrap' }}>
                      <Star size={9} style={{ fill: '#fff' }} /> {t(p.badge as TranslationKey)}
                    </span>
                  </div>
                )}

                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: '#fff', marginBottom: 2 }}>{p.label}</div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.36)' }}>{t(p.sub)}</div>
                </div>

                {/* Price per car badge */}
                <div style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 11, color: '#06b6d4', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.15)', padding: '2px 10px', borderRadius: 100, fontWeight: 700 }}>
                    {fmtPricePerCar(priceBook.price_per_car_cents[p.id])} € {t('landing.pricing.perVehiclePerMonth')}
                  </span>
                </div>

                {/* Main price display */}
                <div style={{ marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                    <span style={{ fontSize: 44, fontWeight: 900, lineHeight: 1, letterSpacing: '-0.03em', color: '#fff' }}>
                      {fmtPrice(displayMonthly)}€
                    </span>
                    <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)' }}>{t('landing.pricing.perMonth')}</span>
                  </div>
                  {billing === 'yearly' && (
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
                      = {fmtPrice(displayYearly)} € {t('landing.pricing.perYearInclDiscount', { pct: priceBook.yearly_discount_percent })}
                    </div>
                  )}
                </div>

                {/* Discount pills */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20 }}>
                  {bp.fleetDiscountPct > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#34d399', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', padding: '2px 8px', borderRadius: 100 }}>
                      -{bp.fleetDiscountPct}% {t('landing.pricing.fleetDiscount')}
                    </span>
                  )}
                  {billing === 'yearly' && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.2)', padding: '2px 8px', borderRadius: 100 }}>
                      -{priceBook.yearly_discount_percent}% {t('landing.pricing.yearlyDiscount')}
                    </span>
                  )}
                </div>

                <a href="/signup" style={{
                  display: 'block', width: '100%', textAlign: 'center',
                  padding: '13px 0', borderRadius: 14, fontSize: 13, fontWeight: 800,
                  textDecoration: 'none', marginBottom: 20, transition: 'all 0.25s',
                  background: p.highlight ? 'linear-gradient(90deg,#06b6d4,#818cf8)' : 'rgba(255,255,255,0.055)',
                  color: '#fff',
                  boxShadow: p.highlight ? '0 4px 28px rgba(6,182,212,0.3)' : '0 0 0 1px rgba(255,255,255,0.07)',
                }}>
                  {t('landing.pricing.cta', { days: trialDays })}
                </a>

                <div style={{ height: 1, background: p.highlight ? 'rgba(6,182,212,0.15)' : 'rgba(255,255,255,0.05)', marginBottom: 20 }} />

                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {p.features.map((featureKey, j) => (
                    <li key={j} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'rgba(255,255,255,0.65)' }}>
                      <span style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: p.highlight ? 'rgba(6,182,212,0.18)' : 'rgba(255,255,255,0.06)' }}>
                        <CheckCircle size={9} style={{ color: p.highlight ? '#22d3ee' : 'rgba(255,255,255,0.4)' }} />
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
        <div style={{ marginTop: 40, padding: '20px 24px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 16, maxWidth: 700, margin: '40px auto 0' }}>
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', lineHeight: 1.7, textAlign: 'center', margin: 0 }}>
            <strong style={{ color: 'rgba(255,255,255,0.55)' }}>{t('landing.pricing.fleetDiscount')}:</strong> {fleetDiscountSummary(priceBook, t, tPlural)}
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <strong style={{ color: 'rgba(255,255,255,0.55)' }}>{t('landing.pricing.yearlyDiscount')}:</strong> {t('landing.pricing.yearlyNote', { pct: priceBook.yearly_discount_percent })}
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
    <div onClick={() => setOpen(!open)} style={{
      background: open ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
      border: `1px solid ${open ? 'rgba(6,182,212,0.2)' : BORDER}`,
      borderRadius: 12,
      cursor: 'pointer',
      overflow: 'hidden',
      transition: 'all 0.25s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', gap: 16 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.8)' }}>{q}</span>
        <ChevronDown size={16} style={{ color: 'rgba(255,255,255,0.3)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.25s' }} />
      </div>
      {open && (
        <div style={{ padding: '0 22px 18px' }}>
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.46)', lineHeight: 1.7, margin: 0 }}>{a}</p>
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

  // Padding lives in classes, not in the style object: inline styles cannot
  // change with the screen width, and sections need less of it on a phone.
  const sectionStyle = (): React.CSSProperties => ({ position: 'relative', zIndex: 10 });
  const sectionClass = (compact = false) =>
    compact ? 'px-4 py-14 md:px-5 md:py-20' : 'px-4 py-[72px] md:px-5 md:py-[120px]';

  const sectionHead = (centered = true): React.CSSProperties => ({
    textAlign: centered ? 'center' : 'left',
    maxWidth: centered ? 600 : undefined,
    margin: centered ? '0 auto 64px' : '0 0 48px',
  });

  const h2Style: React.CSSProperties = {
    fontSize: 'clamp(28px,4vw,52px)', fontWeight: 900, lineHeight: 1.1,
    letterSpacing: '-0.025em', marginBottom: 18,
  };

  const bodyStyle: React.CSSProperties = {
    fontSize: 15, color: 'rgba(255,255,255,0.45)', lineHeight: 1.65,
  };

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#fff', overflowX: 'hidden', fontFamily: '"Inter","Helvetica Neue",Arial,sans-serif' }}>
      <BgOrbs />

      {/* ── Navbar ── */}
      <header style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50,
        background: scrolled ? 'rgba(7,9,15,0.85)' : 'transparent',
        backdropFilter: scrolled ? 'blur(20px)' : 'none',
        borderBottom: scrolled ? '1px solid rgba(255,255,255,0.06)' : '1px solid transparent',
        transition: 'all 0.3s',
      }}>
        <div className="px-4 md:px-6" style={{ maxWidth: 1200, margin: '0 auto', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <img src="/professor_logo_white.svg" alt="El-Professor" style={{ height: 30, objectFit: 'contain' }} />

          <nav style={{ alignItems: 'center', gap: 28 }} className="hidden md:flex">
            {navLinks.map(l => (
              <a key={l.href} href={l.href} style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', textDecoration: 'none', transition: 'color 0.2s' }}
                onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.5)')}
              >{l.label}</a>
            ))}
          </nav>

          <div className="hidden md:flex" style={{ alignItems: 'center', gap: 12 }}>
            <Link to="/login" style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', textDecoration: 'none', padding: '8px 12px', transition: 'color 0.2s' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
              onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.55)')}
            >{t('auth.signIn')}</Link>
            <Link to="/signup" style={{
              fontSize: 13, fontWeight: 700, color: '#fff', textDecoration: 'none',
              padding: '9px 20px', borderRadius: 10,
              background: 'linear-gradient(90deg,#06b6d4,#818cf8)',
              boxShadow: '0 2px 20px rgba(6,182,212,0.3)',
              transition: 'all 0.2s',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 28px rgba(6,182,212,0.5)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 20px rgba(6,182,212,0.3)'; (e.currentTarget as HTMLElement).style.transform = 'none'; }}
            >{t('landing.nav.tryFree')}</Link>
          </div>

          <button className="md:hidden" onClick={() => setMobileOpen(!mobileOpen)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', padding: 4 }}>
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>

        {mobileOpen && (
          <div style={{ background: 'rgba(7,9,15,0.97)', backdropFilter: 'blur(20px)', borderBottom: `1px solid ${BORDER}`, padding: '16px 24px 20px' }}>
            {navLinks.map(l => (
              <a key={l.href} href={l.href} onClick={() => setMobileOpen(false)} style={{ display: 'block', fontSize: 14, color: 'rgba(255,255,255,0.6)', textDecoration: 'none', padding: '10px 0', borderBottom: `1px solid ${BORDER}` }}>{l.label}</a>
            ))}
            <Link to="/login" onClick={() => setMobileOpen(false)} style={{ display: 'block', textAlign: 'center', marginTop: 14, fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.8)', textDecoration: 'none', padding: '12px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)' }}>
              {t('auth.signIn')}
            </Link>
            <Link to="/signup" onClick={() => setMobileOpen(false)} style={{ display: 'block', textAlign: 'center', marginTop: 10, fontSize: 14, fontWeight: 700, color: '#fff', textDecoration: 'none', padding: '12px', borderRadius: 12, background: 'linear-gradient(90deg,#06b6d4,#818cf8)' }}>
              {t('landing.nav.tryFree')}
            </Link>
          </div>
        )}
      </header>

      {/* ── Hero ── */}
      <section style={sectionStyle()} className="px-4 pt-[104px] pb-16 md:px-5 md:pt-[120px] md:pb-[100px]">
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16">

            {/* Left */}
            <div style={{ maxWidth: 540, minWidth: 0 }}>
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.2)',
                borderRadius: 100, padding: '6px 14px', marginBottom: 28,
                fontSize: 11, fontWeight: 700, color: '#06b6d4', letterSpacing: '0.06em',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#34d399', boxShadow: '0 0 6px rgba(52,211,153,0.8)', animation: 'pulse 2s infinite' }} />
                {t('landing.hero.badge')}
              </div>

              <h1 className="max-lg:break-words max-lg:[hyphens:auto]" style={{ fontSize: 'clamp(32px,5vw,68px)', fontWeight: 900, lineHeight: 1.0, letterSpacing: '-0.03em', marginBottom: 24 }}>
                {t('landing.hero.titleLead')}<br />
                <GradientText>{t('landing.hero.titleHighlight')}</GradientText><br />
                {t('landing.hero.titleTail')}
              </h1>

              <p style={{ fontSize: 16, color: 'rgba(255,255,255,0.48)', lineHeight: 1.65, marginBottom: 36, maxWidth: 440 }}>
                {t('landing.hero.subtitle')}
              </p>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 40 }}>
                <Link to="/signup" style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  background: 'linear-gradient(90deg,#06b6d4,#818cf8)',
                  color: '#fff', fontWeight: 700, fontSize: 14,
                  padding: '13px 26px', borderRadius: 12, textDecoration: 'none',
                  boxShadow: '0 0 32px rgba(6,182,212,0.35)',
                  transition: 'all 0.25s',
                }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 0 52px rgba(6,182,212,0.55)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 0 32px rgba(6,182,212,0.35)'; (e.currentTarget as HTMLElement).style.transform = 'none'; }}
                >
                  {t('landing.hero.ctaPrimary')} <ArrowRight size={15} />
                </Link>
                <a href="#features" style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                  color: 'rgba(255,255,255,0.8)', fontWeight: 600, fontSize: 14,
                  padding: '13px 22px', borderRadius: 12, textDecoration: 'none', transition: 'all 0.25s',
                }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.09)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.18)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.1)'; }}
                >
                  {t('landing.hero.ctaSecondary')}
                </a>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
                {[t('landing.hero.noCreditCard'), t('landing.trust.gdpr'), t('landing.trust.madeInGermany')].map((badge, i) => (
                  <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'rgba(255,255,255,0.32)' }}>
                    <CheckCircle size={12} style={{ color: '#34d399' }} /> {badge}
                  </span>
                ))}
              </div>
            </div>

            {/* Right: dashboard */}
            <div style={{ position: 'relative' }}>
              <HeroDashboard />
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats strip ── */}
      <section style={{ position: 'relative', zIndex: 10 }} className="px-4 md:px-5">
        <div className="px-5 py-6 md:px-10 md:py-8" style={{ maxWidth: 1000, margin: '0 auto', background: CARD, border: `1px solid ${BORDER}`, borderRadius: 16 }}>
          <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
            {[
              { v: '500+', l: t('landing.stats.bookings') },
              { v: '98%', l: t('landing.stats.satisfaction') },
              { v: t('landing.stats.timeSavedValue'), l: t('landing.stats.timeSaved') },
              { v: '99.9%', l: t('landing.stats.uptime') },
            ].map((s, i) => (
              <div key={i} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: '-0.03em', background: 'linear-gradient(90deg,#06b6d4,#818cf8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', marginBottom: 6 }}>{s.v}</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.38)' }}>{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pain section ── */}
      <section style={sectionStyle()} className={sectionClass()}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={sectionHead()}>
            <Tag>{t('landing.pain.tag')}</Tag>
            <h2 style={h2Style}>
              {t('landing.pain.titleLead')} <GradientText>{t('landing.pain.titleHighlight')}</GradientText>
            </h2>
            <p style={bodyStyle}>{t('landing.pain.body')}</p>
          </div>

          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <PainCard value="90%" label={t('landing.pain.time.label')} desc={t('landing.pain.time.desc')} accent="linear-gradient(90deg,#06b6d4,#22d3ee)" />
            <PainCard value="0" label={t('landing.pain.payrollErrors.label')} desc={t('landing.pain.payrollErrors.desc')} accent="linear-gradient(90deg,#818cf8,#a78bfa)" />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <PainCard value="100%" label={t('landing.pain.fleet.label')} desc={t('landing.pain.fleet.desc')} accent="linear-gradient(90deg,#34d399,#06b6d4)" />
            <PainCard value="1" label={t('landing.pain.onePlatform.label')} desc={t('landing.pain.onePlatform.desc')} accent="linear-gradient(90deg,#f472b6,#818cf8)" />
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" style={sectionStyle()} className={sectionClass()}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={sectionHead()}>
            <Tag>{t('landing.features.tag')}</Tag>
            <h2 style={h2Style}>
              {t('landing.features.titleLead')} <GradientText>{t('landing.features.titleHighlight')}</GradientText>
            </h2>
            <p style={bodyStyle}>{t('landing.features.body')}</p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { icon: <TrendingUp size={18}/>, title: t('landing.feature.revenue.title'), desc: t('landing.feature.revenue.desc'), accent: '#06b6d4' },
              { icon: <FileText size={18}/>, title: t('landing.feature.belege.title'), desc: t('landing.feature.belege.desc'), accent: '#818cf8' },
              { icon: <Users size={18}/>, title: t('landing.feature.drivers.title'), desc: t('landing.feature.drivers.desc'), accent: '#22d3ee' },
              { icon: <DollarSign size={18}/>, title: t('landing.feature.payroll.title'), desc: t('landing.feature.payroll.desc'), accent: '#f59e0b' },
              { icon: <Wallet size={18}/>, title: t('nav.bargeldbestand'), desc: t('landing.feature.cash.desc'), accent: '#34d399' },
              { icon: <BarChart3 size={18}/>, title: t('landing.feature.abrechnung.title'), desc: t('landing.feature.abrechnung.desc'), accent: '#38bdf8' },
              { icon: <Car size={18}/>, title: t('landing.feature.fleet.title'), desc: t('landing.feature.fleet.desc'), accent: '#a78bfa' },
              { icon: <Wrench size={18}/>, title: t('landing.feature.werkstatt.title'), desc: t('landing.feature.werkstatt.desc'), accent: '#fb923c' },
              { icon: <Target size={18}/>, title: t('landing.feature.dashboard.title'), desc: t('landing.feature.dashboard.desc'), accent: '#f472b6' },
              { icon: <Receipt size={18}/>, title: t('nav.documents'), desc: t('landing.feature.documents.desc'), accent: '#4ade80' },
              { icon: <Settings size={18}/>, title: t('locked.feature.rollenNutzer'), desc: t('landing.feature.roles.desc'), accent: '#60a5fa' },
              { icon: <CreditCard size={18}/>, title: t('nav.fixkosten'), desc: t('landing.feature.fixedCosts.desc'), accent: '#c084fc' },
            ].map((f, i) => (
              <FeatureCard key={i} {...f} />
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="workflow" style={sectionStyle()} className={sectionClass()}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 64 }}>
            <Tag>{t('landing.how.tag')}</Tag>
            <h2 style={h2Style}>{t('landing.how.titleLead')} <GradientText>{t('landing.how.titleHighlight')}</GradientText></h2>
            <p style={bodyStyle}>{t('landing.how.body')}</p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              { n: '01', title: t('landing.how.step1.title'), desc: t('landing.how.step1.desc') },
              { n: '02', title: t('landing.how.step2.title'), desc: t('landing.how.step2.desc') },
              { n: '03', title: t('landing.how.step3.title'), desc: t('landing.how.step3.desc') },
            ].map((s, i) => {
              const [hovered, setHovered] = React.useState(false);
              return (
                <div
                  key={i}
                  onMouseEnter={() => setHovered(true)}
                  onMouseLeave={() => setHovered(false)}
                  style={{
                    background: CARD,
                    border: `1px solid ${hovered ? 'rgba(6,182,212,0.2)' : BORDER}`,
                    borderRadius: 16, padding: '28px 24px',
                    position: 'relative', overflow: 'hidden',
                    boxShadow: hovered ? '0 8px 32px rgba(6,182,212,0.07)' : 'none',
                    transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
                    cursor: 'default',
                  }}
                >
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg,#06b6d4,#818cf8)', opacity: hovered ? 0.75 : 0.5, transition: 'opacity 0.3s ease' }} />
                  <div style={{
                    fontSize: 40, fontWeight: 900, letterSpacing: '-0.04em', marginBottom: 14, lineHeight: 1,
                    transition: 'color 0.35s ease, text-shadow 0.35s ease',
                    color: hovered ? 'rgba(6,182,212,0.55)' : 'rgba(255,255,255,0.06)',
                    textShadow: hovered ? '0 0 32px rgba(6,182,212,0.5), 0 0 8px rgba(6,182,212,0.3)' : 'none',
                  }}>{s.n}</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#fff', marginBottom: 10 }}>{s.title}</div>
                  <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.42)', lineHeight: 1.65 }}>{s.desc}</div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Product screenshots ── */}
      <section id="screenshots" style={sectionStyle()} className={sectionClass()}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={sectionHead()}>
            <Tag>{t('landing.nav.insights')}</Tag>
            <h2 style={h2Style}>
              {t('landing.screens.titleLead')}<br /><GradientText>{t('landing.screens.titleHighlight')}</GradientText>
            </h2>
            <p style={bodyStyle}>{t('landing.screens.body')}</p>
          </div>

          {/* Row 1 */}
          <div className="mb-5 grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', marginBottom: 6 }}>{t('landing.screens.payout.title')}</div>
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.42)', lineHeight: 1.65, marginBottom: 16 }}>{t('landing.screens.payout.body')}</div>
                {[t('landing.screens.payout.point1'),t('landing.screens.payout.point2'),t('landing.screens.payout.point3'),t('landing.screens.payout.point4')].map((f,i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 7 }}>
                    <CheckCircle size={12} style={{ color: '#06b6d4', flexShrink: 0 }} /> {f}
                  </div>
                ))}
              </div>
            </div>
            <AbrechnungPanel />
          </div>

          {/* Row 2 */}
          <div className="mb-5 grid grid-cols-1 gap-5 md:grid-cols-2">
            <KassePanel />
            <div className="order-first md:order-none" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', marginBottom: 6 }}>{t('landing.screens.cash.title')}</div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.42)', lineHeight: 1.65, marginBottom: 16 }}>{t('landing.screens.cash.body')}</div>
              {[t('landing.screens.cash.point1'),t('landing.screens.cash.point2'),t('landing.screens.cash.point3'),t('landing.screens.cash.point4')].map((f,i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 7 }}>
                  <CheckCircle size={12} style={{ color: '#818cf8', flexShrink: 0 }} /> {f}
                </div>
              ))}
            </div>
          </div>

          {/* Row 3 */}
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', marginBottom: 6 }}>{t('landing.screens.fleet.title')}</div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.42)', lineHeight: 1.65, marginBottom: 16 }}>{t('landing.screens.fleet.body')}</div>
              {[t('landing.screens.fleet.point1'),t('landing.screens.fleet.point2'),t('landing.screens.fleet.point3'),t('landing.screens.fleet.point4')].map((f,i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 7 }}>
                  <CheckCircle size={12} style={{ color: '#f59e0b', flexShrink: 0 }} /> {f}
                </div>
              ))}
            </div>
            <FuhrparkPanel />
          </div>
        </div>
      </section>

      {/* ── Trust strip ── */}
      <section style={{ position: 'relative', zIndex: 10 }} className="px-4 pb-16 md:px-5 md:pb-20">
        <div style={{ maxWidth: 1000, margin: '0 auto' }}>
          <div className="grid grid-cols-1 gap-4 px-5 py-5 sm:grid-cols-2 md:px-10 md:py-6 lg:grid-cols-4 lg:gap-5" style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 16 }}>
            {[
              { icon: <Shield size={16} style={{ color: '#34d399' }} />, label: t('landing.trust.gdpr'), sub: t('landing.trust.gdprSub') },
              { icon: <Zap size={16} style={{ color: '#06b6d4' }} />, label: t('landing.trust.realtime.label'), sub: t('landing.trust.realtime.sub') },
              { icon: <Globe size={16} style={{ color: '#818cf8' }} />, label: t('landing.trust.anywhere.label'), sub: t('landing.trust.anywhere.sub') },
              { icon: <Clock size={16} style={{ color: '#f59e0b' }} />, label: t('landing.trust.support.label'), sub: t('landing.trust.support.sub') },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {item.icon}
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.8)' }}>{item.label}</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{item.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ── */}
      <PricingSection />

      {/* ── Testimonials ── */}
      <section style={sectionStyle()} className={sectionClass(true)}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <Tag>{t('landing.testimonials.tag')}</Tag>
            <h2 style={{ ...h2Style, fontSize: 'clamp(28px,3vw,42px)' }}>{t('landing.testimonials.title')}</h2>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              { name: 'Mehmet A.', role: t('landing.testimonials.role1'), quote: t('landing.testimonials.quote1') },
              { name: 'Klaus T.', role: t('landing.testimonials.role2'), quote: t('landing.testimonials.quote2') },
              { name: 'Ahmad S.', role: t('landing.testimonials.role3'), quote: t('landing.testimonials.quote3') },
            ].map((testimonial, i) => (
              <div key={i} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 16, padding: '24px 22px', transition: 'border-color 0.25s' }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.14)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = BORDER)}
              >
                <div style={{ display: 'flex', gap: 2, marginBottom: 14 }}>
                  {Array(5).fill(0).map((_,j) => <Star key={j} size={13} style={{ color: '#fbbf24', fill: '#fbbf24' }} />)}
                </div>
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.7, marginBottom: 18, fontStyle: 'italic' }}>"{testimonial.quote}"</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg,#06b6d4,#818cf8)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: '#fff' }}>
                    {testimonial.name.charAt(0)}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{testimonial.name}</div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.32)' }}>{testimonial.role}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" style={sectionStyle()} className={sectionClass()}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 56 }}>
            <Tag>{t('landing.nav.faq')}</Tag>
            <h2 style={h2Style}>{t('landing.faq.titleLead')} <GradientText violet>{t('landing.faq.titleHighlight')}</GradientText></h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
      <section style={sectionStyle()} className={sectionClass(true)}>
        <div style={{ maxWidth: 860, margin: '0 auto', position: 'relative' }}>
          {/* Glow */}
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 50% 50%, rgba(6,182,212,0.12) 0%, rgba(129,140,248,0.08) 40%, transparent 70%)', filter: 'blur(40px)', pointerEvents: 'none' }} />

          <div className="px-5 py-12 md:px-12 md:py-[72px]" style={{
            position: 'relative',
            background: 'linear-gradient(160deg, rgba(13,28,52,0.9) 0%, rgba(7,13,26,0.95) 100%)',
            border: '1px solid rgba(6,182,212,0.18)',
            borderRadius: 24,
            textAlign: 'center',
            boxShadow: '0 0 0 1px rgba(129,140,248,0.08), 0 40px 100px rgba(0,0,0,0.6)',
            overflow: 'hidden',
          }}>
            {/* Top glow line */}
            <div style={{ position: 'absolute', top: 0, left: '20%', right: '20%', height: 1, background: 'linear-gradient(90deg, transparent, rgba(6,182,212,0.6), transparent)' }} />

            <Tag>{t('landing.cta.tag')}</Tag>
            <h2 style={{ ...h2Style, marginBottom: 16 }}>
              {t('landing.cta.titleLead')}<br /><GradientText>{t('landing.cta.titleHighlight')}</GradientText>
            </h2>
            <p style={{ ...bodyStyle, maxWidth: 440, margin: '0 auto 36px' }}>
              {t('landing.cta.body')}
            </p>
            <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link to="/signup" style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                background: 'linear-gradient(90deg,#06b6d4,#818cf8)',
                color: '#fff', fontWeight: 700, fontSize: 14,
                padding: '13px 28px', borderRadius: 12, textDecoration: 'none',
                boxShadow: '0 0 40px rgba(6,182,212,0.4)',
                transition: 'all 0.25s',
              }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 0 60px rgba(6,182,212,0.6)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 0 40px rgba(6,182,212,0.4)'; (e.currentTarget as HTMLElement).style.transform = 'none'; }}
              >
                {t('landing.cta.primary')} <ArrowRight size={15} />
              </Link>
              <a href="#features" style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                color: 'rgba(255,255,255,0.75)', fontWeight: 600, fontSize: 14,
                padding: '13px 22px', borderRadius: 12, textDecoration: 'none', transition: 'all 0.25s',
              }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.09)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'}
              >
                {t('landing.cta.secondary')}
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer style={{ position: 'relative', zIndex: 10, borderTop: `1px solid ${BORDER}`, padding: '48px 24px 32px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div className="mb-10 grid grid-cols-2 gap-x-6 gap-y-8 md:mb-12 md:grid-cols-[2fr_1fr_1fr_1fr] md:gap-10">
            <div className="col-span-2 md:col-span-1">
              <img src="/professor_logo_white.svg" alt="El-Professor" style={{ height: 28, objectFit: 'contain', marginBottom: 14, opacity: 0.8 }} />
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', lineHeight: 1.65, maxWidth: 260 }}>
                {t('landing.footer.tagline')}
              </p>
            </div>
            {[
              { head: t('landing.footer.product'), links: [{ l: t('landing.nav.features'), h: '#features' }, { l: t('landing.nav.insights'), h: '#screenshots' }, { l: t('landing.nav.pricing'), h: '#pricing' }] },
              { head: t('landing.footer.company'), links: [{ l: t('landing.nav.faq'), h: '#faq' }, { l: t('landing.footer.support'), h: '#faq' }, { l: t('legal.link.impressum'), h: LEGAL_PATHS.impressum }, { l: t('legal.link.privacy'), h: LEGAL_PATHS.privacy }] },
              { head: t('landing.footer.access'), links: [{ l: t('auth.signIn'), h: '/login' }, { l: t('landing.nav.tryFree'), h: '/login' }] },
            ].map((col, i) => (
              <div key={i}>
                <div style={{ fontSize: 11, fontWeight: 800, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 16 }}>{col.head}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {col.links.map((lk, j) => (
                    <a key={j} href={lk.h} style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', textDecoration: 'none', transition: 'color 0.2s' }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                      onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.45)')}
                    >{lk.l}</a>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.22)' }}>© {new Date().getFullYear()} El-Professor. {t('landing.footer.rights')}</p>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.22)' }}>{t('landing.trust.gdpr')} · {t('landing.trust.madeInGermany')}</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
