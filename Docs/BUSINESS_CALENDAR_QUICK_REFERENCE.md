# Business Calendar - Quick Reference Guide

## The Golden Rule

**A week belongs to the month where its MONDAY is.**

## When to Use What

### Frontend (TypeScript)

```typescript
import {
  getWeekMonday,
  getBusinessWeekRange,
  getBusinessMonth,
  getBusinessMonthRange,
  getBusinessWeeksForMonth,
  getWeeksOfMonth,
  getWeekNumberForDate
} from '../utils/weekCalculations';
```

### Common Use Cases:

#### 1. Get the Monday of any date:
```typescript
const monday = getWeekMonday(new Date('2024-04-03')); // Returns Monday of that week
```

#### 2. Get full week range (Monday-Sunday):
```typescript
const { monday, sunday } = getBusinessWeekRange(new Date());
// monday: 2024-04-01, sunday: 2024-04-07
```

#### 3. Determine which month a date belongs to:
```typescript
const { month, year } = getBusinessMonth(new Date('2024-04-03'));
// If April 3 is in a week that started in March, returns: { month: 2, year: 2024 }
// (month is 0-indexed: 0=Jan, 1=Feb, 2=Mar, etc.)
```

#### 4. Get date range for a business month:
```typescript
const { start, end } = getBusinessMonthRange(3, 2024); // April 2024
// start: First Monday in April
// end: Last Sunday of last week starting in April
```

#### 5. Get all weeks for a month:
```typescript
const weeks = getBusinessWeeksForMonth(3, 2024); // April 2024
// Returns array of weeks whose Monday is in April
[
  { weekNumber: 1, label: "Woche 1 (01.04 - 07.04)", firstDay: ..., lastDay: ... },
  { weekNumber: 2, label: "Woche 2 (08.04 - 14.04)", firstDay: ..., lastDay: ... },
  ...
]
```

#### 6. Get week number for a date:
```typescript
const weekNum = getWeekNumberForDate(new Date('2024-04-10'));
// Returns the week number within the business month (1-5)
```

---

## Database (SQL)

### Available Functions:

#### 1. Get Monday of week:
```sql
SELECT get_week_monday('2024-04-03'::date);
-- Returns: 2024-04-01
```

#### 2. Get business month:
```sql
SELECT * FROM get_business_month('2024-04-03'::date);
-- Returns: { month: 4, year: 2024 }
```

#### 3. Get week number:
```sql
SELECT get_business_week_number('2024-04-10'::date, 4, 2024);
-- Returns: 2 (second week in April business month)
```

---

## Common Patterns

### Pattern 1: Initialize with Business Month
```typescript
const now = new Date();
const businessMonth = getMonth(now); // 0-11
const businessYear = getYear(now);
const { start, end } = getBusinessMonthRange(businessMonth, businessYear);

setFromDate(format(start, 'yyyy-MM-dd'));
setToDate(format(end, 'yyyy-MM-dd'));
```

### Pattern 2: Handle Month Selection
```typescript
const handleMonthChange = (monthStr: string) => {
  const date = new Date(monthStr + '-01');
  const month = getMonth(date);
  const year = getYear(date);
  const { start, end } = getBusinessMonthRange(month, year);

  setSelectedMonth(monthStr);
  setStartDate(format(start, 'yyyy-MM-dd'));
  setEndDate(format(end, 'yyyy-MM-dd'));
};
```

### Pattern 3: Get Current Week
```typescript
const { monday, sunday } = getBusinessWeekRange(new Date());
setStartDate(format(monday, 'yyyy-MM-dd'));
setEndDate(format(sunday, 'yyyy-MM-dd'));
```

### Pattern 4: Get Available Weeks for Date Selection
```typescript
useEffect(() => {
  if (selectedDate) {
    const weeks = getWeeksOfMonth(new Date(selectedDate));
    setAvailableWeeks(weeks);

    const weekNumber = getWeekNumberForDate(new Date(selectedDate));
    setSelectedWeek(weekNumber);
  }
}, [selectedDate]);
```

---

## Database Query Examples

### Query receipts by business month:
```sql
SELECT r.*, bm.month, bm.year
FROM receipts r
CROSS JOIN LATERAL get_business_month(r.date) AS bm
WHERE bm.month = 4 AND bm.year = 2024;
```

### Group by business week:
```sql
SELECT
  bm.year,
  bm.month,
  get_business_week_number(r.date, bm.month, bm.year) AS week_number,
  COUNT(*) AS count,
  SUM(r.amount) AS total
FROM receipts r
CROSS JOIN LATERAL get_business_month(r.date) AS bm
WHERE bm.month = 4 AND bm.year = 2024
GROUP BY bm.year, bm.month, get_business_week_number(r.date, bm.month, bm.year);
```

---

## Salary Calculation Formula

```typescript
// Step 1: Filter income for business month period
const driverIncomes = incomes.filter(income =>
  income.driver_name === driver.name &&
  income.date >= periodStart &&
  income.date <= periodEnd
);

// Step 2: Calculate online revenue (Umsatz + Aktionen)
const onlineRevenue = driverIncomes
  .filter(i => i.type === 'umsatz' || i.type === 'aktionen')
  .reduce((sum, i) => sum + Number(i.amount), 0);

// Step 3: Calculate tips (100% to driver)
const tips = driverIncomes
  .filter(i => i.type === 'trinkgeld')
  .reduce((sum, i) => sum + Number(i.amount), 0);

// Step 4: Calculate revenue share
const salaryRatio = driver.salary_ratio ?? 0.5;
const revenueShare = onlineRevenue * salaryRatio;

// Step 5: Total salary
const totalSalary = revenueShare + tips;
```

**Important Notes:**
- **Umsatz + Aktionen** = Online Revenue (subject to percentage split)
- **Trinkgeld** = 100% to driver (not split)
- **Bargeld** = NOT counted as online revenue

---

## Testing Checklist

- [ ] Receipts dated in early April (week starting in March) appear in March
- [ ] Income week dropdown shows correct weeks for selected month
- [ ] Salary calculation includes Aktionen with Umsatz
- [ ] Salary calculation gives 100% Trinkgeld to driver
- [ ] Weekly settlement shows Monday-Sunday boundaries
- [ ] No week is split across two months
- [ ] Month filters use business month ranges
- [ ] All modules use consistent date boundaries

---

## Quick Debugging

### Frontend: Check which month a date belongs to
```typescript
console.log(getBusinessMonth(new Date('2024-04-03')));
// Expected: { month: 3, year: 2024 } if Monday is in April
// or { month: 2, year: 2024 } if Monday is in March
```

### Database: Check week assignment
```sql
SELECT
  '2024-04-03'::date AS test_date,
  get_week_monday('2024-04-03'::date) AS monday,
  (SELECT * FROM get_business_month('2024-04-03'::date)) AS business_month;
```

### Verify business month range
```typescript
const { start, end } = getBusinessMonthRange(3, 2024); // April
console.log('Start:', format(start, 'yyyy-MM-dd'));
console.log('End:', format(end, 'yyyy-MM-dd'));
// Should show first Monday in April to last Sunday of last week starting in April
```

---

## Remember

1. Always use business calendar functions for date operations
2. Never manually calculate week boundaries - use the utilities
3. Week = Monday to Sunday (never split)
4. Month assignment = based on week's Monday
5. Frontend and database use same logic
