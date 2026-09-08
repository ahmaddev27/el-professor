# 🚀 Quick Start - Salaries Feature

## ⚡ 3-Step Setup

### 1️⃣ Apply Database Migration (REQUIRED)
Open the file `apply_salaries_migration.sql` and **copy ALL its contents** into your Supabase SQL Editor:
1. Go to: https://supabase.com/dashboard → Your Project → SQL Editor
2. Click "New query"
3. Paste the entire SQL file
4. Click "Run" (or Ctrl+Enter)

### 2️⃣ Verify It Worked
Run this quick check in SQL Editor:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'drivers' AND column_name = 'salary_ratio';

SELECT table_name FROM information_schema.tables
WHERE table_name = 'salaries';
```
✅ You should see both results found!

### 3️⃣ Start Using The Feature
1. **Refresh your app** - The "Gehälter" menu should now work
2. **Set driver ratios** - Go to Fahrer page → Edit each driver → Set their salary percentage (default is 50%)
3. **View salaries** - Go to Gehälter page to see calculated salaries

---

## 📋 What You Got

### New Database Stuff
- **`drivers.salary_ratio`** - Each driver's revenue share (0-100%, stored as 0.0-1.0)
- **`salaries` table** - Tracks monthly salary records per driver

### New UI Features
- **Gehälter Page** (`/salaries`) - Full salary management
- **Driver Modal** - Now includes salary ratio field
- **Excel Export** - Professional salary reports

### How Salaries Are Calculated
```
For each driver, per month:
  Revenue Share = (Sum of all Umsatz) × driver.salary_ratio
  Tips = Sum of all Trinkgeld (100% goes to driver)
  Amount Due = Revenue Share + Tips
```

Example:
- Driver has 60% ratio (0.6)
- Month revenue: 10,000€ in Umsatz, 500€ in Trinkgeld
- Salary = (10,000 × 0.6) + 500 = 6,500€

---

## 🎯 Quick Tour

### Gehälter Page Features

**Top Bar:**
- 📅 Month selector + custom date range
- 👤 Filter by driver
- ✅ Filter by status (Paid/Unpaid/All)
- 📊 Export to Excel

**KPI Cards:**
- Total Due (all drivers)
- Total Tips
- Total Revenue Share
- Paid vs Unpaid counts

**Salary Table:**
| Column | What It Shows |
|--------|---------------|
| Fahrer | Driver name |
| Umsatz | Total revenue for period |
| Anteil | Their percentage (salary_ratio) |
| Umsatzanteil | Revenue × ratio |
| Trinkgeld | Tips (100%) |
| Fälliger Betrag | Total owed |
| Status | Paid/Unpaid with date |
| Aktionen | View details / Mark paid/unpaid |

**Permissions:**
- Everyone can VIEW salaries
- Only ADMINS can mark as paid/unpaid
- Non-admins see disabled buttons with "Admin only" tooltip

---

## 🐛 Troubleshooting

### "The table salaries does not exist"
→ You need to run the SQL migration! See Step 1 above.

### "Column salary_ratio does not exist"
→ Same - run the migration from `apply_salaries_migration.sql`

### Drivers don't show salary ratio
→ Edit each driver in Fahrer page to set their percentage

### Can't mark as paid
→ Only admin users can change status. Check your user role.

### Export button is disabled
→ No salary data for selected filters. Try changing date range or filters.

---

## 📁 Files Created/Modified

### New Files:
- `src/components/SalariesManagement.tsx` - Main salaries component
- `src/pages/SalariesPage.tsx` - Page wrapper
- `supabase/migrations/20251012100000_create_salaries_system.sql` - Migration
- `apply_salaries_migration.sql` - **COPY THIS TO SUPABASE SQL EDITOR**
- `SALARIES_SETUP_INSTRUCTIONS.md` - Detailed setup guide

### Modified Files:
- `src/types/receipt.ts` - Added Salary types
- `src/utils/excelExport.ts` - Added salary export function
- `src/components/DriverModal.tsx` - Added salary ratio field
- `src/components/DriversManagement.tsx` - Updated for salary ratio
- `src/components/Sidebar.tsx` - Added Gehälter menu item
- `src/pages/FahrerPage.tsx` - Updated driver handlers
- `src/hooks/useDatabase.ts` - Support for salary_ratio CRUD
- `src/App.tsx` - Added /salaries route

---

## ✅ Success Checklist

- [ ] Ran SQL migration in Supabase
- [ ] Verified tables/columns exist
- [ ] Refreshed application
- [ ] "Gehälter" appears in left sidebar
- [ ] Can navigate to /salaries page
- [ ] Can edit drivers and set salary ratio
- [ ] Can view calculated salaries
- [ ] Can export to Excel
- [ ] (Admin only) Can mark salaries as paid

---

## 💡 Tips

1. **Set driver ratios FIRST** - Go to Fahrer page and edit each driver to set their percentage
2. **Default is 50%** - All drivers start with 50% ratio unless you change it
3. **Filters are powerful** - Use month selector + driver filter to see specific periods
4. **Excel exports respect filters** - The export contains exactly what you see in the table
5. **Details button** - Click the eye icon to see all transactions for a driver in that period

---

## 🆘 Need More Help?

See the full documentation in `SALARIES_SETUP_INSTRUCTIONS.md`
