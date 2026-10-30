# التدقيق الخارجي، الجولة السادسة — ما يحويه التسليم وأين

التكليف: محرّك للرحلات الفارغة، وجدولة تمنع الخطأ قبل وقوعه (لا تكشفه بعده)، وإصلاح «S38»، وقاعدة
المالك النهائية للمرفوض والملغى، وحكم «VALIDATED FOR EXPORT» منفصل عن نجاح التوليد.

الملفات التي فيها بيانات شركة (عناوين، لوحات، أسماء) موجودة في حزمة التسليم وحدها، **لا في git**،
لأن هذا المستودع عام.

| الملف | المحتوى |
|---|---|
| `Befunde.md` | سجل القضايا FB-R6-*، والسبب الجذري والإصلاح والحالة لكل منها |
| `Testprotokoll.md` | كل أمر شُغّل برمز خروجه، وضوابط الطفرة، والتوليد الحقيقي، والمقارنة بالملف المرجعي |

## بنود التكليف وأين نُفّذت

| البند | التنفيذ |
|---|---|
| الرحلة الفارغة سجلّ `REPOSITIONING` / `LEERFAHRT` بكل حقوله | `src/utils/simulatedRides/repositioningLegs.ts`، والورقة L في `operationalReport.ts` |
| قاعدة الجدولة: الطريق + الاستلام + هامش قابل للضبط | `repositioning.ts`، و`generator.ts` (الاقترابات الثلاثة) |
| تفضيل 2–5 دقائق، بلا تعديل أي زمن | `generator.ts` `choosePickup` |
| حالات التحقق الأربع | `routeCheck.ts` و`repositioningLegs.ts` |
| «VALIDATED FOR EXPORT» منفصل عن التوليد | `monthVerification.ts`، والشاشة `CalendarResult.tsx`، واسم الملف |
| إصلاح S38: منع الوردية القصيرة وقت الجدولة | `generator.ts` (`STEP_TRIES`) و`fullMonth.ts` (`shift_too_short`) و`figures.ts` |
| المرفوض خارج Fahrtenbuch، والملغى برسم الشركة | `revenue.ts` (`inExportScope`، `cancellationFeeOf`)، و`monthTotals.ts`، و`monthWorkbook.ts` |
| تقرير تشغيل منفصل | `operationalReport.ts` → `SIMULIERT_Betriebsbericht_…` |
| الأحداث قبل التوليد، والورشة للمراجعة | `fullMonth.ts` (`werkstatt_negative`) |
| تحقق مستقل من بايتات الملفين | `scripts/fleetbook-report-verify.py` (openpyxl وحده) |

## ما لم يُنفَّذ كما طُلب، ولماذا

- **Valhalla.** المالك رفض إضافته في 29.10.2026. المحرّك OSRM عبر بوابتنا، وعنوانه يتبع البيئة،
  وأداة التحقق تقبل `--valhalla <url>` لمن عنده Valhalla.
- **أحداث بثلاثة تواريخ ونافذة صيانة للمركبة:** غير موجودة في نموذج البيانات. فحص الورشة السلبي
  للمراجعة فقط، لأن منعه يعني اختراع نافذة.
- **العودة إلى المقر في آخر الوردية** لا يولّدها المولّد: الوردية تنتهي عند آخر نزول.

## إعادة الإنتاج

```bash
npx vitest run src/utils/simulatedRides --maxWorkers=2 --minWorkers=1      # الوحدات والقبول
npx vite-node scripts/audit-round4-fixture.mts                            # ملفّا الشهر المختلق (حتميان)
cd deploy/export-service && python -m pytest tests -q                     # يكتبهما openpyxl ويعيد قراءتهما
python -I scripts/fleetbook-report-verify.py <Monatsbericht.xlsx> <Betriebsbericht.xlsx>
npx vite-node scripts/fleetbook-route-check.mts --rides <Monatsbericht.xlsx> --out <dir خارج المستودع>
```
