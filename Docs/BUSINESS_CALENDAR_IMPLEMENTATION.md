# Business Calendar Implementation - Complete Summary

## Core Business Rule

**A week belongs to the month where its MONDAY is located.**

- Weeks run Monday to Sunday and are NEVER split across months
- A business month contains all weeks whose Monday falls within that calendar month
- If a date is in April but its week's Monday was in March, that entry belongs to MARCH

## Implementation Overview

The business calendar logic has been implemented consistently across the entire application:

### 1. Shared Utility Functions (`src/utils/weekCalculations.ts`)

Created comprehensive business calendar utility functions:

#### Core Functions:
- **`getWeekMonday(date)`** - Returns the Monday of any given date's week
- **`getBusinessWeekRange(date)`** - Returns the full Monday-Sunday range for a date
- **`getBusinessMonth(date)`** - Returns the business month/year based on the week's Monday
- **`getBusinessWeeksForMonth(month, year)`** - Returns all weeks whose Monday falls in that month
- **`getBusinessMonthRange(month, year)`** - Returns the full date range (earliest Monday to latest Sunday) for a business month
- **`isDateInBusinessMonth(date, month, year)`** - Checks if a date belongs to a business month

#### Updated Existing Functions:
- **`getWeeksOfMonth(date)`** - Now uses business month logic
- **`getWeekNumberForDate(date)`** - Now calculates week number within business month

---

## 2. Module Updates

### **Belege (Receipts)** - `src/components/ReceiptList.tsx`

**Changes:**
- Month filter now uses `getBusinessMonthRange()` to get correct date boundaries
- When user selects a month, the system automatically includes all weeks whose Monday falls in that month
- Initial load uses business month for current period
- Clear filters resets to business month boundaries

**Impact:**
- Receipts dated in early April but in a week starting in March will appear in March's report
- Month summaries reflect true business month totals
- Exports use business month ranges

---

### **Umsätze (Income)** - `src/components/IncomeManagement.tsx`

**Changes:**
- Initial date range uses `getBusinessMonthRange()` for current business month
- Week dropdown populated using `getWeeksOfMonth()` which now returns business weeks
- Date presets (thisWeek, lastWeek, thisMonth, lastMonth) all use business calendar logic:
  - `thisWeek` → `getBusinessWeekRange(now)`
  - `lastWeek` → `getBusinessWeekRange(lastWeekDate)`
  - `thisMonth` → `getBusinessMonthRange(month, year)`
  - `lastMonth` → `getBusinessMonthRange(lastMonth, lastYear)`
- Week number automatically calculated based on business month

**Impact:**
- Income entries are properly assigned to business weeks
- Week selection dropdown shows correct weeks for business month
- If user is in early April but current week started in March, the default week shown is from March
- Month filtering includes complete weeks (Monday-Sunday)
- All income totals calculated using business month boundaries

---

### **Gehaltsabrechnung (Salaries)** - `src/components/SalariesManagement.tsx`

**Changes:**
- Initial period uses `getBusinessMonthRange()` for current business month
- Month selector uses business month boundaries
- Period filtering uses business month start/end dates

**Salary Calculation Formula (Already Correct):**
```
Online Revenue = Sum(Umsatz) + Sum(Aktionen)
Revenue Share = Online Revenue × Driver Percentage
Tips = Sum(Trinkgeld) [100% to driver]
Total Salary = Revenue Share + Tips
```

**Impact:**
- Monthly salaries calculated using business month boundaries
- Aktionen is properly included with Umsatz as online revenue
- Trinkgeld remains 100% for the driver
- Bargeld is not counted as online revenue
- If a week starts in March and ends in April, ALL salary data for that week belongs to March

---

### **Abrechnung (Settlement)** - Database and Frontend

**Weekly View:**
- Uses database RPC `get_weekly_abrechnung(year, month)`
- Backend view `abrechnung_weekly` updated to use business calendar logic
- Groups receipts and cash income by business week (Monday-Sunday)
- Week numbers calculated based on business month

**Monthly View:**
- Automatically aggregates data from business weeks
- Month totals reflect complete weeks only

**Impact:**
- Weekly settlement shows Monday-Sunday boundaries consistently
- No week is ever split across two months
- Belege and Bargeld grouped by the same business week logic
- Monthly reports sum complete business weeks

---

## 3. Database Changes

### **New Migration:** `20260402060000_implement_business_calendar_logic.sql`

#### Database Functions Created:

1. **`get_week_monday(date)`**
   - Returns the Monday for any date's week
   - Used by all other business calendar functions

2. **`get_business_month(date)`**
   - Returns month and year based on the week's Monday
   - Core function for determining business month assignment

3. **`get_business_week_number(date, month, year)`**
   - Calculates week number within a business month
   - Counts Mondays that fall within the specified month

#### Updated Database Views:

**`abrechnung_weekly` View:**
- Completely rewritten to use business calendar logic
- Receipts grouped using `get_business_month(receipt.date)`
- Income grouped using `get_business_month(income.date)`
- Week numbers calculated using `get_business_week_number()`
- Both receipts and income follow identical business calendar rules

#### Updated RPC Functions:

- **`get_weekly_abrechnung(year, month)`** - Returns weekly settlement data for business month
- **`get_driver_weekly_abrechnung(driver_name, year, month)`** - Returns driver-specific weekly data

---

## 4. Consistency Across All Modules

All modules now use the **same shared business calendar logic**:

| Module | Frontend Utility | Database Function | Consistent? |
|--------|------------------|-------------------|-------------|
| Belege | `getBusinessMonthRange()` | `get_business_month()` | ✅ Yes |
| Umsätze | `getBusinessWeekRange()`, `getWeeksOfMonth()` | `get_business_month()` | ✅ Yes |
| Gehaltsabrechnung | `getBusinessMonthRange()` | `get_business_month()` | ✅ Yes |
| Abrechnung Weekly | `getWeeksOfMonth()` | `get_business_week_number()` | ✅ Yes |
| Abrechnung Monthly | Aggregated from weekly | Aggregated from weekly | ✅ Yes |

---

## 5. Example Scenario

### Calendar Example:
```
March 2024:
Mon  Tue  Wed  Thu  Fri  Sat  Sun
                         1    2    3
 4    5    6    7    8    9   10
11   12   13   14   15   16   17
18   19   20   21   22   23   24
25   26   27   28   29   30   31

April 2024:
Mon  Tue  Wed  Thu  Fri  Sat  Sun
 1    2    3    4    5    6    7
 8    9   10   11   12   13   14
```

### Business Week Assignment:

**Week starting Monday, March 25:**
- Runs: March 25 (Mon) - March 31 (Sun)
- **Belongs to:** MARCH (Monday is in March)
- All data from March 25-31 → March report

**Week starting Monday, April 1:**
- Runs: April 1 (Mon) - April 7 (Sun)
- **Belongs to:** APRIL (Monday is in April)
- All data from April 1-7 → April report

### Impact on Reports:

**March Business Month contains:**
- Week 1: March 4-10
- Week 2: March 11-17
- Week 3: March 18-24
- Week 4: March 25-31

**April Business Month contains:**
- Week 1: April 1-7
- Week 2: April 8-14
- Week 3: April 15-21
- Week 4: April 22-28
- Week 5: April 29 - May 5 (if May 5 is Sunday)

---

## 6. Testing and Verification

### Build Status:
✅ **Build completed successfully** - All TypeScript compilation passed

### What to Test:

1. **Belege (Receipts):**
   - Create a receipt on April 1 (if Monday is in March) → Should appear in March
   - Filter by March → Should include all receipts from weeks starting in March
   - Filter by April → Should only show receipts from weeks starting in April

2. **Umsätze (Income):**
   - Add income on April 1 (if that week started in March) → Should default to March week
   - Select "This Month" in April → Should show weeks whose Mondays are in April
   - Week dropdown should show correct weeks for selected month

3. **Gehaltsabrechnung (Salaries):**
   - Calculate salary for March → Should include all weeks whose Monday is in March
   - Verify Aktionen is included in online revenue
   - Verify Trinkgeld is 100% to driver
   - Check that weeks aren't split across months

4. **Abrechnung (Settlement):**
   - Weekly view for March → Should show weeks 1-4 (or 5) based on Mondays in March
   - Each week should span Monday-Sunday completely
   - Bargeld and Belege should use same week boundaries

---

## 7. Benefits of Business Calendar

### Before (Calendar Month):
- ❌ Weeks split across two months caused confusion
- ❌ Week boundaries inconsistent between reports
- ❌ Difficult to track weekly performance
- ❌ Month-end calculations included partial weeks

### After (Business Month):
- ✅ Weeks never split - always Monday to Sunday
- ✅ Consistent week boundaries across all modules
- ✅ Clear weekly performance tracking
- ✅ Month reports include complete weeks only
- ✅ Early-month dates properly assigned to previous month's week

---

## 8. Files Modified

### Frontend Files:
1. `src/utils/weekCalculations.ts` - Core business calendar utilities
2. `src/components/ReceiptList.tsx` - Belege filtering with business month
3. `src/components/IncomeManagement.tsx` - Umsätze with business calendar
4. `src/components/SalariesManagement.tsx` - Salary calculation with business month

### Database Files:
1. `supabase/migrations/20260402060000_implement_business_calendar_logic.sql` - Complete business calendar implementation

### Documentation:
1. `BUSINESS_CALENDAR_IMPLEMENTATION.md` - This comprehensive guide

---

## 9. Key Takeaways

1. **Single Source of Truth:** All modules use the same business calendar logic
2. **Week Integrity:** Weeks are never split across months
3. **Monday Rule:** The week's Monday determines which month it belongs to
4. **Salary Formula:** Umsatz + Aktionen = Online Revenue; Trinkgeld = 100% driver
5. **Consistency:** Frontend and backend use identical business calendar rules
6. **No Data Loss:** All data properly assigned to correct business period

---

## Support

If you encounter any issues:
1. Verify the date's Monday falls in the expected month
2. Check that week boundaries are Monday-Sunday
3. Ensure business month ranges are used for filtering
4. Confirm database migration was applied successfully
