# التدقيق الخارجي، الجولة الرابعة — ما يحويه التسليم وأين

قرارات المالك في 29.10.2026 سبعة. هذا المجلد يلخّصها ويقيسها. الملفات التي فيها بيانات شركة
(عناوين، لوحات، أسماء) موجودة في حزمة التسليم وحدها، **لا في git**، لأن هذا المستودع عام.

| الملف | المحتوى |
|---|---|
| `Befunde.md` | سجل القضايا FB-R4-*، الحالة والسبب الجذري والدليل لكل قضية |
| `Testprotokoll.md` | كل أمر شُغّل، برمز خروجه كما كتبه الأمر نفسه، والتشغيلات التي فشلت |

## قرارات المالك وأين نُفّذت

| # | القرار | التنفيذ |
|---|---|---|
| 1 | شهر تقويمي كامل، ووضع الأسابيع خياراً منفصلاً | `src/pages/SimulatedRidesPage.tsx`: تبويبا **Kalendermonat** و**Geschäftswochen** |
| 2 | أزمنة القيادة من خدمة مسارات، لا من ثوابت سرعة | `src/utils/simulatedRides/travelModel.ts` و`src/lib/simulationRouting.ts` |
| 3 | 6.00 € لكل Declined مؤهلة، منفصلة عن الإلغاء | `fullMonth.ts` (`idle_in_shift`) و`revenue.ts` |
| 4 | نسبة شهرية 30–33 % من seed، معروضة في الواجهة | `monthlyRate.ts` و`CalendarSettings.tsx` و`CalendarResult.tsx` |
| 5 | الأحداث تُقرأ قبل التوليد، المؤكَّد قطعي وغير المؤكَّد للمراجعة | `simulationConstraints.ts` و`simulationInputsClient.ts` |
| 6 | ملف XLSX كامل من داخل التطبيق، موسوم SIMULIERT | `monthWorkbook.ts` (`buildMonthReport`) ويكتبه openpyxl عبر خدمة التصدير |
| 7 | اختبارات وتوليد حقيقي وإعادة فحص | `Testprotokoll.md`، و`scripts/fleetbook-route-check.mts`، و`scripts/audit-round4-verify.py` |

## ما لم يُنفَّذ، ولماذا

- **Valhalla.** لا يعمل في أي مكان نتحكم به: لا على الخادم ولا على جهاز التطوير. جهاز التطوير
  فيه 7.7 GB من الذاكرة، والحرّ منها أقل من 1 GB أثناء العمل، وبناء خرائط Valhalla يحتاج عدة
  جيجابايتات. محرّك المنتج هو **OSRM** عبر بوابتنا (قرار المالك في 25.10.2026). ووضع Valhalla على
  الخادم تغيير على الخادم ينتظر موافقته.
  - أرقام Valhalla في المقارنة هي أرقام المدقق نفسه، من ملفه.
- **إصلاح الجيوكود** يعمل على الخادم، فأثره الكامل يظهر بعد النشر. تحقّقنا منه قبل النشر بالطلب نفسه
  الذي سيرسله. التفاصيل في `Befunde.md`.

## إعادة الإنتاج

```bash
npx vite-node scripts/audit-round4-fixture.mts          # شهر مختلق، حتمي (نفس الـsha256 في كل مرة)
cd deploy/export-service && python -m pytest tests -q    # يكتبه بكاتب الخدمة ويعيد جمعه بـopenpyxl
python scripts/audit-round4-verify.py <ملف.xlsx>         # يفحص أي تقرير من بايتاته، بلا أي JavaScript
npx vite-node scripts/fleetbook-route-check.mts --rides <ملف.xlsx>   # إعادة فحص المسارات بخدماتنا
```
