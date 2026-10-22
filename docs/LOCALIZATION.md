# Languages

The apps (desktop, Android and iOS) speak **English** and **Arabic**. English is the source:
every string is written in English first, and Arabic follows this guide and glossary so the three
apps use the same words for the same things.

## The language setting

Each app offers **System** (the default), **English** and **العربية**. System follows the
device: Arabic when the operating system's first preferred language is Arabic (`ar`, `ar-SA`,
`ar-EG`…), English otherwise. Language names are always shown in their own language ("English",
"العربية"), whatever the app's language is. Changing the language takes effect without losing
anything open; a restart is acceptable only where the platform requires one.

- **Desktop** keeps the choice with its other app settings and switches in place.
- **Android** uses per-app languages (`locales_config.xml`, `AppCompatDelegate` /
  `LocaleManager`), so the choice also appears in Android's own app-language settings. System
  is the empty locale list.
- **iOS** uses the system's per-app language (Settings → UrBudget → Language), which appears
  once the app has more than one localization. The app's Settings shows the current language
  and opens that page.

Arabic lays the whole interface out right to left. Amounts, dates, account numbers, emails, URLs
and user-entered names keep their own direction inside it (bidi isolation), so `-1,234.56`
or `john@example.com` never come out scrambled.

## The shared engine

The Rust engine (`crates/`) writes some messages people see: errors, sync and import status.
It has its own copy of the strings and a process-wide language:

- `urbudget_services::i18n::set_language(code)` with `"ar"` or `"en"` (anything else is English);
- mobile apps call the service method `set_language` with `{ "language": "ar" | "en" }`, and the
  desktop app the Tauri command `set_language` with `{ language }`;
- each app calls it at startup and whenever its resolved language changes, with the resolved
  code (never `"system"`), and ignores a failure.

## What is never translated

- **People's data:** budget, category, group, account, payee and memo text, including names the
  engine created once and stored (a new budget's starter categories may be created in the
  language in use; after that they're the person's data).
- **Stored or exchanged formats:** file formats, CSV and JSON column names, backup contents, API
  fields, identifiers, and anything another device reads during sync.
- **Number, currency and date formats:** these follow the budget's own format settings, not
  the app language. Arabic text uses the same Western digits (0–9) as the budget.
- **Names:** UrBudget, YNAB, SimpleFIN, ChatGPT, OpenAI, Anthropic, Microsoft Store, App
  Store, Google Play, Polar, Windows, macOS, iPhone, iPad, Android.
- **Keyboard keys:** Enter, Esc, Tab, Shift, Ctrl, ⌘ and the like, as printed on keyboards.
- Developer-only text: logs, crash details, debug screens.

## Arabic style

- **Modern Standard Arabic**, plain and short, as in well-made Arabic software. Translate the
  meaning, never word for word; rewrite a sentence when the English order reads badly in Arabic.
- **Commands** (buttons, menu items, toolbar actions) use the verbal noun: حفظ، إلغاء، حذف،
  تعديل، إضافة، استيراد. **Instructions** in sentences address the reader directly with the
  imperative: «اختر حسابًا»، «أدخل الرمز المرسل إلى بريدك».
- Avoid gendered forms where a neutral phrasing exists; otherwise use the masculine form, as
  Apple's and Microsoft's Arabic do.
- **Punctuation:** Arabic comma «،», semicolon «؛» and question mark «؟»; quotation marks «».
  No space before punctuation. Keep the English full stop habits of each string: a label without
  a full stop stays without one.
- **Plurals** use all of Arabic's forms (zero, one, two, few, many, other), never a single
  "(s)"-style form: لا معاملات، معاملة واحدة، معاملتان، 3 معاملات، 11 معاملة، 100 معاملة.
- **Placeholders** (`{name}`, `%s`, `%1$d`, `\(value)`) stay exactly as in English, moved to
  wherever the Arabic sentence needs them.
- Keep labels about as short as the English; buttons and tabs have little room.
- Use tashkeel only where a word is otherwise ambiguous: المخصَّص، مُسدَّد.

## Glossary

Use these everywhere. If a term you need isn't here, choose one, use it consistently, and add it.

| English | Arabic | Notes |
| --- | --- | --- |
| budget | الميزانية | budgets: الميزانيات |
| budget library | مكتبة الميزانيات | |
| envelope budgeting | الميزانية بالمظاريف | |
| category | الفئة | categories: الفئات |
| group, category group | المجموعة، مجموعة الفئات | |
| assign (money) | تخصيص؛ خصِّص | |
| Assigned | المخصَّص | column and amount |
| Unassigned (money left to assign) | غير المخصَّص | «مال غير مخصَّص» in sentences |
| Available | المتاح | |
| Activity | النشاط | |
| spending; spent | الإنفاق؛ المُنفَق | |
| income | الدخل | |
| inflow; outflow | وارد؛ صادر | transaction amount columns |
| overspent, overspending | تجاوز الإنفاق | «إنفاق زائد» for the amount |
| underfunded; overfunded | ناقص التمويل؛ زائد التمويل | |
| cover overspending | تغطية الإنفاق الزائد | |
| move money | نقل المال | |
| quick assign | التخصيص السريع | |
| target | الهدف | targets: الأهداف |
| needed | المطلوب | |
| snooze | تأجيل | |
| hidden | مخفية | الفئات المخفية |
| fresh start | بداية جديدة | |
| account (money) | الحساب | accounts: الحسابات |
| UrBudget account (sign-in) | حسابك في UrBudget | only where it could be mistaken for a money account |
| Account & sync | الحساب والمزامنة | |
| cash and bank | النقد والبنوك | |
| checking | حساب جارٍ | |
| savings | حساب توفير | |
| credit card | بطاقة ائتمان | |
| tracking account | حساب تتبُّع | |
| loan; debts | قرض؛ الديون | |
| paid off | مُسدَّد | |
| net worth | صافي الثروة | |
| assets; liabilities | الأصول؛ الالتزامات | |
| balance | الرصيد | |
| starting balance | الرصيد الافتتاحي | |
| transaction | المعاملة | transactions: المعاملات |
| register | سجل المعاملات | |
| payee | المستفيد | payees: المستفيدون |
| memo (transaction) | البيان | as on bank statements |
| note (category, month) | ملاحظة | |
| flag | علامة | |
| approve; needs approval | اعتماد؛ بانتظار الاعتماد | |
| needs a category; uncategorized | تحتاج إلى فئة؛ بلا فئة | |
| cleared; uncleared | مُقاصّة؛ غير مُقاصّة | the bank has (not yet) processed it |
| reconcile; reconciled | تسوية؛ مُسوّاة | |
| split | تقسيم | split transaction: معاملة مقسَّمة |
| transfer | تحويل | |
| scheduled transaction | معاملة مجدولة | |
| repeat | تكرار | |
| enter (a scheduled transaction) | إدخال | |
| skip | تخطٍّ | button: تخطي |
| pause; resume | إيقاف مؤقت؛ استئناف | |
| payment; monthly payment | دفعة؛ الدفعة الشهرية | |
| interest rate | سعر الفائدة | |
| forecast | التوقعات | |
| report; reports | تقرير؛ التقارير | |
| cash age (age of money) | عمر المال | |
| budget surplus | فائض الميزانية | |
| money in; money out | الأموال الواردة؛ الأموال الصادرة | |
| sync | المزامنة | |
| sync passphrase | عبارة مرور المزامنة | |
| end-to-end encrypted | مشفَّرة تشفيرًا تامًّا بين الطرفين | |
| sign in; sign out | تسجيل الدخول؛ تسجيل الخروج | |
| subscription; subscribe | الاشتراك؛ اشترك | |
| restore purchases | استعادة المشتريات | |
| manage subscription | إدارة الاشتراك | |
| backup; restore | نسخة احتياطية؛ استعادة | |
| import; export | استيراد؛ تصدير | |
| bank file, statement | كشف حساب | |
| bank connection | ربط البنك | |
| assistant | المساعد | |
| settings | الإعدادات | |
| update; install and restart | تحديث؛ تثبيت وإعادة التشغيل | |
| undo; redo | تراجع؛ إعادة | |
| save; cancel; delete; edit; add | حفظ؛ إلغاء؛ حذف؛ تعديل؛ إضافة | |
| done; close; apply; change | تم؛ إغلاق؛ تطبيق؛ تغيير | |
| retry; continue; open; search | إعادة المحاولة؛ متابعة؛ فتح؛ بحث | |
| month; previous month; next month | الشهر؛ الشهر السابق؛ الشهر التالي | |
| language; System | اللغة؛ لغة النظام | |
