export type SortDirection = 'asc' | 'desc';
export type SortValue = string | number | null | undefined;

// German collation: "Ärger" sorts with "Arger", and "Fahrzeug 10" after
// "Fahrzeug 9".
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

function isEmpty(value: SortValue): value is null | undefined | '' {
  return value === null || value === undefined || value === '';
}

function compare(a: Exclude<SortValue, null | undefined>, b: Exclude<SortValue, null | undefined>): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/**
 * Sort rows by one value, stably, with empty values last in either direction,
 * so a column that is mostly filled never opens on a screen of blanks.
 */
export function sortRows<T>(rows: readonly T[], getValue: (row: T) => SortValue, direction: SortDirection): T[] {
  const sign = direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: getValue(row) }))
    .sort((left, right) => {
      const leftEmpty = isEmpty(left.value);
      const rightEmpty = isEmpty(right.value);
      if (leftEmpty || rightEmpty) {
        if (leftEmpty && rightEmpty) return left.index - right.index;
        return leftEmpty ? 1 : -1;
      }
      const order = compare(left.value as string | number, right.value as string | number);
      return order === 0 ? left.index - right.index : order * sign;
    })
    .map(entry => entry.row);
}
