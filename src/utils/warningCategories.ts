export type WarningCategory =
  | 'critical'
  | 'transfer'
  | 'shift'
  | 'target'
  | 'note';

export interface CategorizedWarning {
  category: WarningCategory;
  text: string;
  date: string | null;
}

export interface WarningGroup {
  category: WarningCategory;
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
  items: CategorizedWarning[];
}

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2}):\s*/;

function extractDate(text: string): string | null {
  const m = text.match(DATE_PREFIX);
  return m ? m[1] : null;
}

function classify(text: string): WarningCategory {
  if (
    text.includes('Ueberlappende Fahrten') ||
    text.includes('Mehr als 3 Schichten') ||
    text.includes('nicht abgedeckt') ||
    text.includes('uncovered') ||
    text.includes('partially_covered') ||
    text.includes('Fahrt nicht in Schicht') ||
    text.includes('liegt ausserhalb')
  ) return 'critical';

  if (
    text.includes('Transfer') ||
    text.includes('transfer') ||
    text.includes('Anschlussfahrt') ||
    text.includes('knappe Anschlussfahrten') ||
    text.includes('kritische Transfer')
  ) return 'transfer';

  if (
    text.includes('laenger als') ||
    text.includes('Schicht') ||
    text.includes('Pause') ||
    text.includes('Arbeitszeit')
  ) return 'shift';

  if (
    text.includes('Pflichtnotiz') ||
    text.includes('Bestehender Stundennachweis') ||
    text.includes('Fahrer nicht in aktiver')
  ) return 'note';

  if (
    text.includes('Gehalt') ||
    text.includes('Salary') ||
    text.includes('Zielgehalt') ||
    text.includes('Stunden') ||
    text.includes('hourly')
  ) return 'target';

  return 'critical';
}

const GROUP_META: Record<WarningCategory, { label: string; color: string; bgColor: string; borderColor: string }> = {
  critical: {
    label: 'Kritische Konflikte',
    color: '#dc2626',
    bgColor: 'rgba(220,38,38,0.06)',
    borderColor: 'rgba(220,38,38,0.3)',
  },
  transfer: {
    label: 'Anschlussfahrt-Warnungen',
    color: '#d97706',
    bgColor: 'rgba(217,119,6,0.06)',
    borderColor: 'rgba(217,119,6,0.3)',
  },
  shift: {
    label: 'Schicht-Warnungen',
    color: '#2563eb',
    bgColor: 'rgba(37,99,235,0.06)',
    borderColor: 'rgba(37,99,235,0.3)',
  },
  target: {
    label: 'Ziel / Gehalt',
    color: '#7c3aed',
    bgColor: 'rgba(124,58,237,0.06)',
    borderColor: 'rgba(124,58,237,0.3)',
  },
  note: {
    label: 'Notizen & Hinweise',
    color: '#059669',
    bgColor: 'rgba(5,150,105,0.06)',
    borderColor: 'rgba(5,150,105,0.3)',
  },
};

const CATEGORY_ORDER: WarningCategory[] = ['critical', 'transfer', 'shift', 'target', 'note'];

export function categorizeWarnings(warnings: string[]): WarningGroup[] {
  const seen = new Set<string>();
  const buckets = new Map<WarningCategory, CategorizedWarning[]>();
  for (const cat of CATEGORY_ORDER) buckets.set(cat, []);

  for (const w of warnings) {
    const key = w.trim();
    if (seen.has(key)) continue;
    seen.add(key);

    const cat = classify(w);
    const date = extractDate(w);
    buckets.get(cat)!.push({ category: cat, text: w, date });
  }

  const groups: WarningGroup[] = [];
  for (const cat of CATEGORY_ORDER) {
    const items = buckets.get(cat)!;
    if (items.length === 0) continue;
    groups.push({ ...GROUP_META[cat], category: cat, items });
  }
  return groups;
}

export function formatDateDE(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

export function groupByDate(items: CategorizedWarning[]): Map<string, CategorizedWarning[]> {
  const map = new Map<string, CategorizedWarning[]>();
  for (const item of items) {
    const key = item.date ?? '_no_date';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  return map;
}
