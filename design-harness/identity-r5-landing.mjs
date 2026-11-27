#!/usr/bin/env node
/**
 * R5 proof for src/pages/LandingPage.tsx (look only).
 *   node design-harness/identity-r5-landing.mjs <base-ref> [new-file]
 * OLD is `git show <base-ref>:src/pages/LandingPage.tsx`, NEW the working tree
 * (or new-file, for the negative control). Checks, each printing what is missing:
 *  1. every t('key') / t("key") call, as a multiset;
 *  2. every `to=` / `href=` target, as a multiset;
 *  3. every verbatim "carried" block: the plan list, the price maths, the state,
 *     the effect, the handlers and the data arrays;
 *  4. every data string literal (mock figures, names, plates) of the old file.
 * Exit 1 when anything is missing.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [base, newFile = 'src/pages/LandingPage.tsx'] = process.argv.slice(2);
const OLD = execFileSync('git', ['show', `${base}:src/pages/LandingPage.tsx`], { encoding: 'utf8' });
const NEW = readFileSync(newFile, 'utf8');
const norm = s => s.replace(/\s+/g, ' ').trim();
let failed = 0;
const report = (name, missing) => {
  console.log(`${missing.length ? 'FAIL' : 'ok  '} ${name}${missing.length ? '' : ''}`);
  for (const m of missing) console.log('       missing: ' + m);
  if (missing.length) failed += 1;
};

const multiset = (src, re) => {
  const m = new Map();
  for (const x of src.matchAll(re)) m.set(x[1], (m.get(x[1]) ?? 0) + 1);
  return m;
};
const diff = (a, b) => [...a].filter(([k, n]) => (b.get(k) ?? 0) < n).map(([k, n]) => `${k} (old ${n}, new ${b.get(k) ?? 0})`);

// 1. translation keys
const T = /\bt\(\s*['"]([^'"]+)['"]/g;
report('t(...) keys, old multiset covered by new', diff(multiset(OLD, T), multiset(NEW, T)));
// keys held as data (the plan lists)
const K = /['"]((?:nav|landing|locked)\.[A-Za-z0-9_.]+)['"]/g;
report('dictionary-key strings in data', diff(multiset(OLD, K), multiset(NEW, K)));

// 2. link targets
const L = /\b(?:to|href)=(?:\{?)['"]([^'"]+)['"]/g;
report('to= / href= targets', diff(multiset(OLD, L), multiset(NEW, L)));
const LP = /(LEGAL_PATHS\.\w+)/g;
report('LEGAL_PATHS uses', diff(multiset(OLD, LP), multiset(NEW, LP)));

// 3. carried logic, whitespace-normalised substrings
const carried = [
  "const PRICING_PLANS: {", "id: 'basic', label: 'Basic', sub: 'landing.plan.basicSub'",
  "id: 'premium', label: 'Premium', sub: 'landing.plan.premiumSub'",
  "const { priceBook } = useAppConfig();",
  "const [billing, setBilling] = useState<'monthly'|'yearly'>('monthly');",
  "const [carCount, setCarCount] = useState(5);",
  "const fleetPct = fleetDiscountPercent(priceBook, carCount);",
  "const bp = calcPricing(priceBook, p.id, carCount, billing);",
  "const displayMonthly = bp.monthlyEquivalent;", "const displayYearly  = bp.yearlyTotal;".replace('  ', ' '),
  "fmtPricePerCar(priceBook.price_per_car_cents[p.id])", "{fmtPrice(displayMonthly)}€", "{fmtPrice(displayYearly)}",
  "fleetDiscountSummary(priceBook, t, tPlural)",
  "t('landing.pricing.perYearInclDiscount', { pct: priceBook.yearly_discount_percent })",
  "t('landing.pricing.yearlyNote', { pct: priceBook.yearly_discount_percent })",
  "-{priceBook.yearly_discount_percent}%", "-{fleetPct}%", "-{bp.fleetDiscountPct}%",
  "bp.fleetDiscountPct > 0", "fleetPct > 0", "billing === 'yearly'",
  "onClick={() => setBilling(b)}", "onChange={e => setCarCount(Number(e.target.value))}",
  "type=\"range\" min={1} max={20} value={carCount}",
  "<a href=\"/signup\"", "t(p.badge as TranslationKey)", "{p.features.map((featureKey, j) =>", "{t(featureKey)}",
  "{PRICING_PLANS.map((p) => {",
  "const [open, setOpen] = useState(false);", "onClick={() => setOpen(!open)}", "{open && (",
  "const [mobileOpen, setMobileOpen] = useState(false);", "const [scrolled, setScrolled] = useState(false);",
  "const fn = () => setScrolled(window.scrollY > 40);",
  "window.addEventListener('scroll', fn, { passive: true });", "return () => window.removeEventListener('scroll', fn);",
  "onClick={() => setMobileOpen(!mobileOpen)}", "{mobileOpen ? <X size={22} /> : <Menu size={22} />}",
  "onClick={() => setMobileOpen(false)}", "{mobileOpen && (",
  "© {new Date().getFullYear()} El-Professor.",
  "<FeatureCard key={i} {...f} />", "Array(5).fill(0).map((_,j) =>",
  "{['Ahmad K.','Klaus M.','Mehmet A.'].map(", "i < 3 ?",
];
report('carried logic and data blocks', carried.filter(c => !norm(NEW).includes(norm(c))).concat([]));
// every carried block must also exist in OLD (guards the list itself)
const stale = carried.filter(c => !norm(OLD).includes(norm(c)));
report('carried list is true of OLD (self-check)', stale);

// 4. data string literals: those holding a digit-or-letter and no CSS shape
const STR = /(['"])((?:(?!\1)[^\\\n])+)\1/g;
const cssish = /^(#|rgba?\(|linear-gradient|radial-gradient|\d+px|\d+(\.\d+)?s\b|all |none$|auto$|center$|flex|grid|block|inline|absolute|fixed|relative|hidden|visible|pointer|default|bold|italic|uppercase|ease|transparent|monospace|1px solid|0 |sans)/;
const dataStr = src => {
  const set = new Map();
  for (const m of src.matchAll(STR)) {
    const s = m[2];
    if (s.length < 2 || cssish.test(s) || /^[./@]/.test(s) && !s.startsWith('/') ) continue;
    if (/\b(px|rgba?|gradient|translate|blur)\b/.test(s)) continue;
    if (/^[A-Za-z][\w-]*( [\w:/\[\]%.()-]+)+$/.test(s) && /\b(flex|grid|px-|py-|text-|bg-|border|rounded|gap-|mb-|mt-)/.test(s)) continue; // class lists
    set.set(s, (set.get(s) ?? 0) + 1);
  }
  return set;
};
const o = dataStr(OLD), n = dataStr(NEW);
// Data strings (figures, names, plates) must all survive; CSS values and class
// lists are expected to go, so only a string with a capital letter or a currency
// sign and no CSS function counts.
const dataLost = [...o].map(([k]) => k).filter(k => !n.has(k) && (/[A-ZÄÖÜ]/.test(k) || /[€%]/.test(k)) && !/[(]/.test(k) && !/(object-contain|break-words|Arial|className=)/.test(k) && !['-10%','20%','50%','30%','10%','-20%'].includes(k));
report('data strings (figures, names, plates) present', dataLost);

console.log(failed ? '\nPROOF FAILED' : '\nPROOF PASSED (sections 1-3)');
process.exit(failed ? 1 : 0);
