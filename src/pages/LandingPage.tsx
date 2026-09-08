import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  TrendingUp, Users, Wallet, FileText, Car, Wrench, BarChart3,
  ChevronRight, CheckCircle, ArrowRight, Shield, Zap, Globe,
  DollarSign, Target, AlertTriangle, Clock, Star, Menu, X,
  TrendingDown, Calendar, ChevronDown, Receipt, Settings, CreditCard,
} from 'lucide-react';

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

const HeroDashboard: React.FC = () => (
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
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', fontFamily: 'monospace' }}>YA · Dashboard</span>
      </div>

      <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
          {[
            { l: 'Umsatz', v: '28.450 €', d: '+12.4%', pos: true },
            { l: 'Gewinn', v: '8.720 €', d: '+8.1%', pos: true },
            { l: 'Fahrer', v: '12 aktiv', d: null, pos: true },
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
              <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.6)' }}>6-Monats-Trend</div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)' }}>Umsatz & Gewinn</div>
            </div>
            <span style={{ fontSize: 9, fontWeight: 700, color: '#34d399', background: 'rgba(52,211,153,0.1)', padding: '2px 8px', borderRadius: 100 }}>+12.4%</span>
          </div>
          <BarChart />
        </div>

        {/* Bottom panels */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: '10px 12px' }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Einnahmen-Mix</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <RingChart pct={68} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[['#06b6d4','Fahrpreis 68%'],['#818cf8','Bargeld 22%'],['#f472b6','Trinkgeld 10%']].map(([c,l],i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9, color: 'rgba(255,255,255,0.55)' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: c as string, flexShrink: 0 }} />
                    {l}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: '10px 12px' }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Top-Fahrer</div>
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
          <span style={{ fontSize: 9, color: 'rgba(251,191,36,0.8)' }}>2 offene Gehaltsabrechnungen · 1.840 € offen</span>
          <span style={{ marginLeft: 'auto', fontSize: 9, color: '#fbbf24', fontWeight: 700 }}>Verwalten →</span>
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
      <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Bargeld</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>3.920 €</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, fontWeight: 700, color: '#34d399', marginTop: 3 }}>
        <TrendingUp size={8} /> +6.2% vs. Vormonat
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
        position: 'absolute', top: 100, right: -56, width: 142,
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
      <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Flotte</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>8 / 9 OK</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, fontWeight: 700, color: '#34d399', marginTop: 3 }}>
        <Car size={8} /> Alle aktiv
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
        position: 'absolute', bottom: 80, right: -52, width: 148,
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
      <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Gewinnmarge</div>
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

const FeatureCard: React.FC<{
  icon: React.ReactNode; title: string; desc: string; accentColor: string;
}> = ({ icon, title, desc, accentColor }) => (
  <div style={{
    background: CARD,
    border: `1px solid ${BORDER}`,
    borderRadius: 14,
    padding: '22px 20px',
    cursor: 'default',
    transition: 'border-color 0.3s, background 0.3s',
  }}
    onMouseEnter={e => {
      (e.currentTarget as HTMLElement).style.borderColor = `${accentColor}33`;
      (e.currentTarget as HTMLElement).style.background = '#121c2d';
    }}
    onMouseLeave={e => {
      (e.currentTarget as HTMLElement).style.borderColor = BORDER;
      (e.currentTarget as HTMLElement).style.background = CARD;
    }}
  >
    <div style={{
      width: 40, height: 40, borderRadius: 10,
      background: `${accentColor}18`,
      border: `1px solid ${accentColor}30`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      marginBottom: 14, color: accentColor,
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

const AbrechnungPanel: React.FC = () => (
  <ScreenPanel title="Fahrerabrechnung" subtitle="KW 14 · April 2026" tag="PDF bereit">
    {[
      { name: 'Ahmad K.', umsatz: '2.840 €', lohn: '1.136 €', status: 'bezahlt', color: '#34d399' },
      { name: 'Klaus M.', umsatz: '2.290 €', lohn: '916 €', status: 'offen', color: '#fbbf24' },
      { name: 'Mehmet A.', umsatz: '3.110 €', lohn: '1.244 €', status: 'bezahlt', color: '#34d399' },
      { name: 'Stefan B.', umsatz: '1.960 €', lohn: '784 €', status: 'offen', color: '#fbbf24' },
    ].map((r, i) => (
      <div key={i} style={{ display: 'flex', alignItems: 'center', padding: '8px 0', borderBottom: i < 3 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
        <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'linear-gradient(135deg,#06b6d4,#818cf8)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 800, color: '#fff', marginRight: 10, flexShrink: 0 }}>
          {r.name.charAt(0)}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.8)' }}>{r.name}</div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>Umsatz {r.umsatz}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: '#fff' }}>{r.lohn}</div>
          <div style={{ fontSize: 9, fontWeight: 700, color: r.color }}>{r.status}</div>
        </div>
      </div>
    ))}
    <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>Gesamt offen</span>
      <span style={{ fontSize: 14, fontWeight: 900, color: '#06b6d4' }}>1.700 €</span>
    </div>
  </ScreenPanel>
);

// ─── Kasse mockup ─────────────────────────────────────────────────────────────

const KassePanel: React.FC = () => (
  <ScreenPanel title="Kassenbestand" subtitle="Stand heute · 09:41 Uhr">
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Aktueller Bestand</div>
      <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: '-0.03em', background: 'linear-gradient(90deg,#06b6d4,#818cf8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
        4.380 €
      </div>
      <div style={{ fontSize: 10, color: '#34d399', fontWeight: 700, marginTop: 2 }}>↑ 320 € gegenüber gestern</div>
    </div>
    <div style={{ marginBottom: 10 }}>
      <LineChart />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {[
        { l: 'Einnahmen heute', v: '+840 €', c: '#34d399' },
        { l: 'Ausgaben heute', v: '-520 €', c: '#f87171' },
        { l: 'Differenz', v: '+320 €', c: '#06b6d4' },
      ].map((row,i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 8 }}>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>{row.l}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: row.c }}>{row.v}</span>
        </div>
      ))}
    </div>
  </ScreenPanel>
);

// ─── Fuhrpark mockup ─────────────────────────────────────────────────────────

const FuhrparkPanel: React.FC = () => (
  <ScreenPanel title="Fuhrpark & Werkstatt" subtitle="9 Fahrzeuge · 1 Prüfung fällig">
    {[
      { kz: 'SG-AB 1234', mod: 'Mercedes Vito', km: '98.400', status: 'OK', c: '#34d399' },
      { kz: 'SG-CD 5678', mod: 'VW Crafter', km: '112.800', status: 'Prüfung', c: '#fbbf24' },
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

// ─── Pricing ──────────────────────────────────────────────────────────────────

import { calcPricing, fleetDiscountPercent, PRICE_PER_CAR, YEARLY_DISCOUNT_PERCENT, fmt as fmtPrice } from '../utils/pricing';
import type { Plan as PricingPlan } from '../contexts/PlanContext';

const PRICING_PLANS: {
  id: PricingPlan;
  label: string;
  sub: string;
  highlight: boolean;
  badge: string;
  features: string[];
}[] = [
  {
    id: 'basic', label: 'Basic', sub: 'Für kleine Flotten.',
    highlight: false, badge: '',
    features: ['Übersicht','Belege','Fahrer','Fahrzeuge','Umsätze','Fixkosten','Bargeldbestand','Backup','Excel-Export'],
  },
  {
    id: 'advanced', label: 'Advanced', sub: 'Für wachsende Unternehmen.',
    highlight: true, badge: 'Am beliebtesten',
    features: ['Übersicht','Belege','Fahrer','Fahrzeuge','Umsätze','Fixkosten','Bargeldbestand','Backup','Excel-Export','Werkstatt','Abrechnung','Notiz','Rollen & Nutzer'],
  },
  {
    id: 'premium', label: 'Premium', sub: 'Für professionelle Fuhrparks.',
    highlight: false, badge: '',
    features: ['Übersicht','Belege','Fahrer','Fahrzeuge','Umsätze','Fixkosten','Bargeldbestand','Backup','Excel-Export','Werkstatt','Abrechnung','Notiz','Rollen & Nutzer','Gehälter','Dokumente'],
  },
];

const PricingSection: React.FC = () => {
  const [billing, setBilling] = useState<'monthly'|'yearly'>('monthly');
  const [carCount, setCarCount] = useState(5);

  const fleetPct = fleetDiscountPercent(carCount);

  return (
    <section id="pricing" style={{ position: 'relative', zIndex: 10, padding: '120px 20px' }}>
      <div style={{ maxWidth: 1140, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', maxWidth: 560, margin: '0 auto 16px' }}>
          <Tag>Preise</Tag>
          <h2 style={{ fontSize: 'clamp(32px,4vw,48px)', fontWeight: 900, lineHeight: 1.1, letterSpacing: '-0.02em', marginBottom: 16 }}>
            Transparente Preise. <GradientText violet>Pro Fahrzeug.</GradientText>
          </h2>
          <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.42)', lineHeight: 1.65 }}>
            Sie zahlen nur für Ihre aktiven Fahrzeuge. Kein Festpreis, kein Kleingedrucktes.
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
                {b === 'monthly' ? 'Monatlich' : (
                  <><span>Jährlich</span>
                  <span style={{ fontSize: 10, fontWeight: 800, background: billing === 'yearly' ? 'rgba(255,255,255,0.2)' : 'rgba(6,182,212,0.15)', color: billing === 'yearly' ? '#fff' : '#06b6d4', padding: '1px 6px', borderRadius: 100 }}>-{YEARLY_DISCOUNT_PERCENT}%</span>
                  </>
                )}
              </button>
            ))}
          </div>

          {/* Car count slider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.35)', whiteSpace: 'nowrap' }}>Fahrzeuge:</span>
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
                -{fleetPct}% Flottenrabatt
              </span>
            )}
          </div>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 20, alignItems: 'center', justifyContent: 'center', justifyItems: 'center', maxWidth: 1080, margin: '0 auto' }}>
          {PRICING_PLANS.map((p) => {
            const bp = calcPricing(p.id, carCount, billing);
            const displayMonthly = bp.monthlyEquivalent;
            const displayYearly  = bp.yearlyTotal;
            return (
              <div key={p.id} style={{
                position: 'relative',
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
                      <Star size={9} style={{ fill: '#fff' }} /> {p.badge}
                    </span>
                  </div>
                )}

                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: '#fff', marginBottom: 2 }}>{p.label}</div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.36)' }}>{p.sub}</div>
                </div>

                {/* Price per car badge */}
                <div style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 11, color: '#06b6d4', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.15)', padding: '2px 10px', borderRadius: 100, fontWeight: 700 }}>
                    {PRICE_PER_CAR[p.id]} € / Fahrzeug / Monat
                  </span>
                </div>

                {/* Main price display */}
                <div style={{ marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                    <span style={{ fontSize: 44, fontWeight: 900, lineHeight: 1, letterSpacing: '-0.03em', color: '#fff' }}>
                      {fmtPrice(displayMonthly)}€
                    </span>
                    <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)' }}>/Monat</span>
                  </div>
                  {billing === 'yearly' && (
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
                      = {fmtPrice(displayYearly)} € / Jahr (inkl. {YEARLY_DISCOUNT_PERCENT}% Jahresrabatt)
                    </div>
                  )}
                </div>

                {/* Discount pills */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20 }}>
                  {bp.fleetDiscountPct > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#34d399', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', padding: '2px 8px', borderRadius: 100 }}>
                      -{bp.fleetDiscountPct}% Flottenrabatt
                    </span>
                  )}
                  {billing === 'yearly' && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.2)', padding: '2px 8px', borderRadius: 100 }}>
                      -{YEARLY_DISCOUNT_PERCENT}% Jahresrabatt
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
                  14 Tage kostenlos starten
                </a>

                <div style={{ height: 1, background: p.highlight ? 'rgba(6,182,212,0.15)' : 'rgba(255,255,255,0.05)', marginBottom: 20 }} />

                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {p.features.map((f, j) => (
                    <li key={j} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'rgba(255,255,255,0.65)' }}>
                      <span style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: p.highlight ? 'rgba(6,182,212,0.18)' : 'rgba(255,255,255,0.06)' }}>
                        <CheckCircle size={9} style={{ color: p.highlight ? '#22d3ee' : 'rgba(255,255,255,0.4)' }} />
                      </span>
                      {f}
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
            <strong style={{ color: 'rgba(255,255,255,0.55)' }}>Flottenrabatt:</strong> 1–5 Fahrzeuge: 0% · 6–10 Fahrzeuge: 5% · 11+ Fahrzeuge: 10%
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <strong style={{ color: 'rgba(255,255,255,0.55)' }}>Jahresrabatt:</strong> weitere 10% bei jährlicher Abrechnung
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
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', fn, { passive: true });
    return () => window.removeEventListener('scroll', fn);
  }, []);

  const navLinks = [
    { href: '#features', label: 'Features' },
    { href: '#screenshots', label: 'Einblicke' },
    { href: '#pricing', label: 'Preise' },
    { href: '#faq', label: 'FAQ' },
  ];

  const sectionStyle = (py = 120): React.CSSProperties => ({
    position: 'relative', zIndex: 10, padding: `${py}px 20px`,
  });

  const sectionHead = (centered = true): React.CSSProperties => ({
    textAlign: centered ? 'center' : 'left',
    maxWidth: centered ? 600 : undefined,
    margin: centered ? '0 auto 64px' : '0 0 48px',
  });

  const h2Style: React.CSSProperties = {
    fontSize: 'clamp(32px,4vw,52px)', fontWeight: 900, lineHeight: 1.1,
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
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <img src="/professor_logo_white.svg" alt="El-Professor" style={{ height: 30, objectFit: 'contain' }} />

          <nav style={{ display: 'flex', alignItems: 'center', gap: 28 }} className="hidden md:flex">
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
            >Anmelden</Link>
            <Link to="/signup" style={{
              fontSize: 13, fontWeight: 700, color: '#fff', textDecoration: 'none',
              padding: '9px 20px', borderRadius: 10,
              background: 'linear-gradient(90deg,#06b6d4,#818cf8)',
              boxShadow: '0 2px 20px rgba(6,182,212,0.3)',
              transition: 'all 0.2s',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 28px rgba(6,182,212,0.5)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 20px rgba(6,182,212,0.3)'; (e.currentTarget as HTMLElement).style.transform = 'none'; }}
            >Kostenlos testen</Link>
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
            <Link to="/signup" onClick={() => setMobileOpen(false)} style={{ display: 'block', textAlign: 'center', marginTop: 14, fontSize: 14, fontWeight: 700, color: '#fff', textDecoration: 'none', padding: '12px', borderRadius: 12, background: 'linear-gradient(90deg,#06b6d4,#818cf8)' }}>
              Kostenlos testen
            </Link>
          </div>
        )}
      </header>

      {/* ── Hero ── */}
      <section style={{ ...sectionStyle(0), paddingTop: 120, paddingBottom: 100 }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 64, alignItems: 'center' }} className="lg:grid-cols-2 grid-cols-1">

            {/* Left */}
            <div style={{ maxWidth: 540 }}>
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.2)',
                borderRadius: 100, padding: '6px 14px', marginBottom: 28,
                fontSize: 11, fontWeight: 700, color: '#06b6d4', letterSpacing: '0.06em',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#34d399', boxShadow: '0 0 6px rgba(52,211,153,0.8)', animation: 'pulse 2s infinite' }} />
                El-Professor · Flottenmanagement All-in-One
              </div>

              <h1 style={{ fontSize: 'clamp(40px,5vw,68px)', fontWeight: 900, lineHeight: 1.0, letterSpacing: '-0.03em', marginBottom: 24 }}>
                Die gesamte<br />
                <GradientText>Fahrerabrechnung</GradientText><br />
                in Minuten. Nicht<br />Stunden.
              </h1>

              <p style={{ fontSize: 16, color: 'rgba(255,255,255,0.48)', lineHeight: 1.65, marginBottom: 36, maxWidth: 440 }}>
                Die einzige Plattform, die Fahrerverwaltung, Buchhaltung, Abrechnungen, Flottenüberwachung und Gehaltsmanagement vereint.
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
                  Jetzt kostenlos starten <ArrowRight size={15} />
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
                  Features entdecken
                </a>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
                {['Keine Kreditkarte', 'DSGVO-konform', 'Made in Germany'].map((t, i) => (
                  <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'rgba(255,255,255,0.32)' }}>
                    <CheckCircle size={12} style={{ color: '#34d399' }} /> {t}
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
      <section style={{ position: 'relative', zIndex: 10, padding: '0 20px' }}>
        <div style={{ maxWidth: 1000, margin: '0 auto', background: CARD, border: `1px solid ${BORDER}`, borderRadius: 16, padding: '32px 40px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 20 }}>
            {[
              { v: '500+', l: 'Buchungen täglich' },
              { v: '98%', l: 'Kundenzufriedenheit' },
              { v: '12 Std.', l: 'Ø Zeit gespart / Monat' },
              { v: '99.9%', l: 'System-Verfügbarkeit' },
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
      <section style={sectionStyle()}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={sectionHead()}>
            <Tag>Das Problem</Tag>
            <h2 style={h2Style}>
              Jeder Montag kostet Sie <GradientText>Stunden<br />und Nerven.</GradientText>
            </h2>
            <p style={bodyStyle}>Die meisten Fahrunternehmen kämpfen täglich mit denselben Problemen — wir haben sie gelöst.</p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16, marginBottom: 16 }}>
            <PainCard value="90%" label="Weniger Zeit für Abrechnungen" desc="Fahrerverwaltung, Umsätze und Gehälter in einer Oberfläche — kein manuelles Excel mehr." accent="linear-gradient(90deg,#06b6d4,#22d3ee)" />
            <PainCard value="0" label="Nachfehler bei Löhnen" desc="Automatische Gehaltsberechnung auf Basis von Umsatz und Provisionsmodell — auf den Cent genau." accent="linear-gradient(90deg,#818cf8,#a78bfa)" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16 }}>
            <PainCard value="100%" label="Überblick über Ihre Flotte" desc="Fahrzeugstatus, Werkstatt-Checks und KM-Stände immer aktuell. Kein Chaos mehr." accent="linear-gradient(90deg,#34d399,#06b6d4)" />
            <PainCard value="1" label="Platform statt 6 Tools" desc="Belege, Abrechnung, Kasse, Fahrer, Gehälter und Dokumente. Alles an einem Ort." accent="linear-gradient(90deg,#f472b6,#818cf8)" />
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" style={sectionStyle()}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={sectionHead()}>
            <Tag>Module & Features</Tag>
            <h2 style={h2Style}>
              Alles, was ein Fuhrparkbetrieb<br />braucht. <GradientText>In einem System.</GradientText>
            </h2>
            <p style={bodyStyle}>Von der Fahrererfassung bis zur Jahresauswertung — jeder Prozess Ihres Unternehmens abgedeckt.</p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
            {[
              { icon: <TrendingUp size={18}/>, title: 'Umsatzverwaltung', desc: 'Fahrpreise, Aktionen, Trinkgeld und Bargeld erfassen und auswerten — pro Fahrer und Periode.', accent: '#06b6d4' },
              { icon: <FileText size={18}/>, title: 'Belegmanagement', desc: 'Ausgaben, Quittungen und Kostenstellen digital erfassen mit automatischer Zuordnung.', accent: '#818cf8' },
              { icon: <Users size={18}/>, title: 'Fahrerverwaltung', desc: 'Fahrerstammdaten, Status, Notizen und Provisionsmodelle zentral verwalten.', accent: '#22d3ee' },
              { icon: <DollarSign size={18}/>, title: 'Gehaltsabrechnung', desc: 'Automatische Berechnung auf Basis von Umsatz und Provisionsmodell — mit Zahlungsstatus.', accent: '#f59e0b' },
              { icon: <Wallet size={18}/>, title: 'Bargeldbestand', desc: 'Kassenstand in Echtzeit: Einnahmen vs. Ausgaben, Differenzen und Risikoampel.', accent: '#34d399' },
              { icon: <BarChart3 size={18}/>, title: 'Abrechnung & Reports', desc: 'Wochen- und Monatsabrechnungen als PDF oder Export — auf Knopfdruck.', accent: '#38bdf8' },
              { icon: <Car size={18}/>, title: 'Fahrzeugflotte', desc: 'Alle Fahrzeuge mit Kennzeichen, KM-Stand und Status auf einen Blick.', accent: '#a78bfa' },
              { icon: <Wrench size={18}/>, title: 'Werkstatt-Checks', desc: 'Wöchentliche Fahrzeug-Checks mit Status, Notizen und Reparaturprotokoll.', accent: '#fb923c' },
              { icon: <Target size={18}/>, title: 'Executive Dashboard', desc: 'KPIs, Trends, Fahrerranking und Smart Insights — sofort auf der Übersichtsseite.', accent: '#f472b6' },
              { icon: <Receipt size={18}/>, title: 'Dokumente', desc: 'Trinkgeld-Quittungen, Stundennachweis und weitere Dokumente als PDF generieren.', accent: '#4ade80' },
              { icon: <Settings size={18}/>, title: 'Rollen & Nutzer', desc: 'Verschiedene Zugriffsrechte für Fahrer, Manager und Administratoren.', accent: '#60a5fa' },
              { icon: <CreditCard size={18}/>, title: 'Fixkosten', desc: 'Wiederkehrende Betriebskosten erfassen und in die Gewinnberechnung einbeziehen.', accent: '#c084fc' },
            ].map((f, i) => (
              <FeatureCard key={i} {...f} />
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="workflow" style={sectionStyle()}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 64 }}>
            <Tag>So einfach</Tag>
            <h2 style={h2Style}>Drei Schritte. <GradientText>Keine Einlernphase.</GradientText></h2>
            <p style={bodyStyle}>Keine IT-Abteilung. Keine lange Einrichtung. Innerhalb eines Tages produktiv.</p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
            {[
              { n: '01', title: 'Starten in 5 Minuten', desc: 'Fahrer und Fahrzeuge anlegen, Provisionsmodelle zuweisen, Einstellungen konfigurieren — fertig.' },
              { n: '02', title: 'Tägliche Daten erfassen', desc: 'Umsätze buchen, Belege hochladen, Bargeld protokollieren. Alles mit wenigen Klicks.' },
              { n: '03', title: 'Abrechnen und abschließen', desc: 'Automatisch berechnete Wochenabrechnungen, Gehaltsübersichten und PDF-Export auf Knopfdruck.' },
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
      <section id="screenshots" style={sectionStyle()}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={sectionHead()}>
            <Tag>Einblicke</Tag>
            <h2 style={h2Style}>
              Bildschirme, die wirklich<br /><GradientText>benutzt werden.</GradientText>
            </h2>
            <p style={bodyStyle}>Kein aufgeräumtes Demo-Interface. Das ist die echte Oberfläche Ihrer täglichen Arbeit.</p>
          </div>

          {/* Row 1 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
            <div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', marginBottom: 6 }}>Fahrerabrechnung, die sich selbst schreibt.</div>
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.42)', lineHeight: 1.65, marginBottom: 16 }}>Wählen Sie die Woche, klicken Sie auf Export — fertig. Das System berechnet Lohn, Trinkgeld und Provision automatisch.</div>
                {['Automatisch berechneter Lohnanteil','Trinkgeld separat ausgewiesen','Status: bezahlt / offen verfolgt','PDF-Export per Knopfdruck'].map((f,i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 7 }}>
                    <CheckCircle size={12} style={{ color: '#06b6d4', flexShrink: 0 }} /> {f}
                  </div>
                ))}
              </div>
            </div>
            <AbrechnungPanel />
          </div>

          {/* Row 2 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
            <KassePanel />
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', marginBottom: 6 }}>Kassenbestand auf den Cent genau.</div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.42)', lineHeight: 1.65, marginBottom: 16 }}>Bargeldeinnahmen, Ausgaben und Differenzen auf einen Blick. Keine Überraschungen mehr beim Tagesabschluss.</div>
              {['Echtzeit-Kassenstand','Tagesverläufe als Chart','Einnahmen-Ausgaben-Differenz','Risikoampel bei Abweichungen'].map((f,i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 7 }}>
                  <CheckCircle size={12} style={{ color: '#818cf8', flexShrink: 0 }} /> {f}
                </div>
              ))}
            </div>
          </div>

          {/* Row 3 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', marginBottom: 6 }}>Fuhrpark und Werkstatt immer im Blick.</div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.42)', lineHeight: 1.65, marginBottom: 16 }}>Welches Fahrzeug braucht Werkstatt? Welches hat wann TÜV? Alle Status in einer Übersicht.</div>
              {['KM-Stand & Status je Fahrzeug','Werkstatt-Checks mit Protokoll','Fälligkeitsampel','Servicehistorie je Fahrzeug'].map((f,i) => (
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
      <section style={{ position: 'relative', zIndex: 10, padding: '0 20px 80px' }}>
        <div style={{ maxWidth: 1000, margin: '0 auto' }}>
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 16, padding: '24px 40px', display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 20 }}>
            {[
              { icon: <Shield size={16} style={{ color: '#34d399' }} />, label: 'DSGVO-konform', sub: 'Daten in der EU' },
              { icon: <Zap size={16} style={{ color: '#06b6d4' }} />, label: 'Echtzeit-Updates', sub: 'Sofort sichtbar' },
              { icon: <Globe size={16} style={{ color: '#818cf8' }} />, label: 'Überall erreichbar', sub: 'Browser-basiert' },
              { icon: <Clock size={16} style={{ color: '#f59e0b' }} />, label: 'Persönlicher Support', sub: 'Einrichtungsservice' },
            ].map((t, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {t.icon}
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.8)' }}>{t.label}</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{t.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ── */}
      <PricingSection />

      {/* ── Testimonials ── */}
      <section style={sectionStyle(80)}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <Tag>Kundenstimmen</Tag>
            <h2 style={{ ...h2Style, fontSize: 'clamp(28px,3vw,42px)' }}>Was unsere Kunden sagen</h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
            {[
              { name: 'Mehmet A.', role: 'Inhaber · 8 Fahrzeuge', quote: 'Seit wir die Software nutzen, spare ich pro Woche mindestens 4 Stunden. Die Gehaltsabrechnung läuft automatisch.' },
              { name: 'Klaus T.', role: 'Geschäftsführer · 14 Fahrer', quote: 'Das Dashboard gibt mir auf einen Blick was ich brauche. Ich sehe sofort ob wir im Plan sind.' },
              { name: 'Ahmad S.', role: 'Flottenmanager · 6 Fahrzeuge', quote: 'Die Werkstatt-Checks und die Flottenübersicht sind Gold wert. Früher hatte ich alles in WhatsApp.' },
            ].map((t, i) => (
              <div key={i} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 16, padding: '24px 22px', transition: 'border-color 0.25s' }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.14)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = BORDER)}
              >
                <div style={{ display: 'flex', gap: 2, marginBottom: 14 }}>
                  {Array(5).fill(0).map((_,j) => <Star key={j} size={13} style={{ color: '#fbbf24', fill: '#fbbf24' }} />)}
                </div>
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.7, marginBottom: 18, fontStyle: 'italic' }}>"{t.quote}"</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg,#06b6d4,#818cf8)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: '#fff' }}>
                    {t.name.charAt(0)}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.32)' }}>{t.role}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" style={sectionStyle()}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 56 }}>
            <Tag>FAQ</Tag>
            <h2 style={h2Style}>Alles, was Sie <GradientText violet>wissen müssen.</GradientText></h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { q: 'Wie schnell kann ich starten?', a: 'Nach der Registrierung können Sie sofort loslegen. Die Einrichtung dauert in der Regel unter einer Stunde. Unser Team unterstützt Sie beim Onboarding.' },
              { q: 'Kann ich bestehende Daten importieren?', a: 'Ja, wir bieten einen strukturierten Daten-Import-Service. Sprechen Sie uns an und wir helfen beim Transfer Ihrer bestehenden Excel-Daten.' },
              { q: 'Wie funktioniert die Gehaltsabrechnung?', a: 'Das System berechnet Gehälter automatisch basierend auf dem Umsatz, dem hinterlegten Provisionsmodell und den Trinkgeldeinnahmen. Jede Periode wird separat abgerechnet.' },
              { q: 'Ist die Software DSGVO-konform?', a: 'Ja, alle Daten werden in der EU gespeichert und verarbeitet. Wir setzen auf Verschlüsselung und ein strenges Zugriffsrollensystem.' },
              { q: 'Können mehrere Benutzer gleichzeitig arbeiten?', a: 'Ja. Das Rollensystem erlaubt es, verschiedenen Mitarbeitern unterschiedliche Zugriffsrechte zuzuweisen — von Fahrern bis zu Administratoren.' },
              { q: 'Gibt es eine Mindestvertragslaufzeit?', a: 'Nein. Alle Pläne sind monatlich kündbar. Kein Risiko, keine Bindung.' },
            ].map((item, i) => (
              <FAQItem key={i} q={item.q} a={item.a} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section style={sectionStyle(80)}>
        <div style={{ maxWidth: 860, margin: '0 auto', position: 'relative' }}>
          {/* Glow */}
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 50% 50%, rgba(6,182,212,0.12) 0%, rgba(129,140,248,0.08) 40%, transparent 70%)', filter: 'blur(40px)', pointerEvents: 'none' }} />

          <div style={{
            position: 'relative',
            background: 'linear-gradient(160deg, rgba(13,28,52,0.9) 0%, rgba(7,13,26,0.95) 100%)',
            border: '1px solid rgba(6,182,212,0.18)',
            borderRadius: 24,
            padding: '72px 48px',
            textAlign: 'center',
            boxShadow: '0 0 0 1px rgba(129,140,248,0.08), 0 40px 100px rgba(0,0,0,0.6)',
            overflow: 'hidden',
          }}>
            {/* Top glow line */}
            <div style={{ position: 'absolute', top: 0, left: '20%', right: '20%', height: 1, background: 'linear-gradient(90deg, transparent, rgba(6,182,212,0.6), transparent)' }} />

            <Tag>Bereit loszulegen?</Tag>
            <h2 style={{ ...h2Style, marginBottom: 16 }}>
              Geben Sie Ihrem Büro<br /><GradientText>den Freitag zurück.</GradientText>
            </h2>
            <p style={{ ...bodyStyle, maxWidth: 440, margin: '0 auto 36px' }}>
              Starten Sie kostenlos. Keine Kreditkarte. Keine Bindung. Innerhalb von Minuten eingerichtet.
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
                Kostenlos starten <ArrowRight size={15} />
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
                Demo ansehen
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer style={{ position: 'relative', zIndex: 10, borderTop: `1px solid ${BORDER}`, padding: '48px 24px 32px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 40, marginBottom: 48 }}>
            <div>
              <img src="/professor_logo_white.svg" alt="El-Professor" style={{ height: 28, objectFit: 'contain', marginBottom: 14, opacity: 0.8 }} />
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', lineHeight: 1.65, maxWidth: 260 }}>
                Die All-in-One Flottenverwaltungssoftware von El-Professor für Taxiunternehmen.
              </p>
            </div>
            {[
              { head: 'Produkt', links: [{ l: 'Features', h: '#features' }, { l: 'Einblicke', h: '#screenshots' }, { l: 'Preise', h: '#pricing' }] },
              { head: 'Unternehmen', links: [{ l: 'FAQ', h: '#faq' }, { l: 'Support', h: '#faq' }] },
              { head: 'Zugang', links: [{ l: 'Anmelden', h: '/login' }, { l: 'Kostenlos testen', h: '/login' }] },
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
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.22)' }}>© 2025 YA Software. Alle Rechte vorbehalten.</p>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.22)' }}>DSGVO-konform · Made in Germany</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
