<div dir="rtl">

# راه‌اندازی روی Cloudflare

یک Worker همه‌چیز را سرو می‌کند: برنامهٔ وب (فایل‌های ثابت)، API (`/api/*`)، سه Durable Object، کار زمان‌بندی‌شدهٔ هر دقیقه، و اتصال به Workers AI، D1 و R2.
بدون سرور دیگر، بدون Docker. دو راه برای deploy هست و هر دو یک فرمان را اجرا می‌کنند (`npm run deploy`):

| راه | برای چه کسی | چه می‌خواهد |
|---|---|---|
| **الف) GitHub Actions** (بدون ترمینال) | اگر فقط مرورگر دارید | دو Secret در GitHub، یک بار کلیک روی «Run workflow» |
| **ب) از رایانهٔ خودتان** | اگر Node.js دارید | `npx wrangler login` و `npm run deploy` |

> **راستی‌آزمایی:** همهٔ منطق برنامه با آزمون خودکار و Worker محلی (workerd) آزمایش شده، ولی **من به حساب Cloudflare دسترسی نداشتم**؛ پس هیچ‌کدام از مراحل زیر روی Cloudflare واقعی اجرا نشده‌اند و هیچ فراخوانی Workers AI واقعی هم انجام نشده است.
> چیزهایی که **خوانده و آزمایش شده‌اند**: منطق ترتیب مراحل (۱۶ آزمون)، اجرای `npm run deploy` با wrangler واقعی که بدون اتصال امن شکست می‌خورد و هیچ‌چیز نمی‌سازد، و رفتار ساخت منابع در **کد منبع** wrangler همین نسخه (۴٫۱۶۲٫۰).
> چیزی که **اجرا نشده**: خودِ ساخت D1/R2 و انتشار روی Cloudflare. بعد از deploy بخش «[بررسی](#بررسی-پس-از-راه‌اندازی)» را حتماً انجام دهید.

## پیش‌نیازها (برای هر دو راه)

| | |
|---|---|
| حساب Cloudflare | با **روش پرداخت ثبت‌شده** |
| **Workers Paid** (۵ دلار در ماه) | **لازم است.** پلن رایگان فقط **۱۰ میلی‌ثانیه CPU برای هر درخواست** دارد؛ ورود/ثبت‌نام این برنامه با PBKDF2 (۱۰۰٬۰۰۰ تکرار، بیشینهٔ مجاز Workers) از آن بیشتر CPU می‌خواهد و خطای ۱۱۰۲ می‌دهد. (طبق مستندات Cloudflare، نوامبر ۲۰۲۶. زمان CPU واقعی را من نتوانستم روی Cloudflare اندازه بگیرم؛ قسمت بررسی را ببینید.) منوی Workers & Pages ← Plans |
| نشانی `workers.dev` | **یک بار** داشبورد Cloudflare ← Workers & Pages را باز کنید؛ اگر حسابتان هنوز زیردامنه ندارد از شما می‌خواهد یکی انتخاب کنید. بدون آن، deploy خودکار شکست می‌خورد |
| نام مدیر | در `apps/api/wrangler.jsonc` مقدار `ADMIN_USERNAMES` را **نام کاربری دلخواه خودتان** بگذارید (بخش «تنظیمات» پایین). **بلافاصله بعد از deploy با همان نام ثبت‌نام کنید**؛ هر کس زودتر با آن نام ثبت‌نام کند مدیر می‌شود |

هزینهٔ Workers AI: ۱۰٬۰۰۰ نورون در روز **رایگان** است و بعد از آن ۰٫۰۱۱ دلار برای هر هزار نورون. برای اینکه یک کاربر نتواند هزینه بسازد، هر کاربر سهمیهٔ خودش را دارد (پیش‌فرض: ۳۰۰٬۰۰۰ توکن در روز، ۴۰۰ درخواست در روز، ۴٬۰۰۰٬۰۰۰ توکن در ماه؛ قابل تغییر با `DEFAULT_*` یا برای هر کاربر با `PUT /api/admin/users/:id/quota`). بعضی مدل‌های Workers AI به پلن پولی یا اعتبار AI Gateway نیاز دارند؛ مدلی که دسترس‌پذیر نباشد در برنامه «آمادهٔ استفاده» نشان داده **نمی‌شود**.

## راه الف: GitHub Actions (بدون ترمینال)

۱. **کد باید در شاخهٔ پیش‌فرض (`Main`) باشد.** GitHub دکمهٔ «Run workflow» را فقط برای workflowهایی نشان می‌دهد که در شاخهٔ پیش‌فرض هستند؛ پس اول Pull Request این کار را Merge کنید.

۲. **شناسهٔ حساب:** داشبورد Cloudflare ← Workers & Pages ← ستون سمت راست ← «Account ID» را کپی کنید.

۳. **توکن API:** [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) ← Create Token ← قالب **Edit Cloudflare Workers**. حساب را به همان حساب خودتان محدود کنید. اگر هنگام اجرا از دسترسی D1 یا R2 شکایت کرد، دو دسترسی **D1: Edit** و **Workers R2 Storage: Edit** را هم اضافه کنید (من محتوای دقیق قالب را نتوانستم ببینم).

۴. در GitHub: مخزن ← Settings ← Secrets and variables ← Actions ← New repository secret، دو مورد:
   `CLOUDFLARE_ACCOUNT_ID` و `CLOUDFLARE_API_TOKEN`. (توکن را هرگز در خود مخزن یا چت ننویسید.)

۵. فایل `apps/api/wrangler.jsonc` را در GitHub باز کنید (آیکن مداد) و `"ADMIN_USERNAMES": "نام-شما"` را بگذارید و Commit کنید.

۶. Actions ← **Deploy to Cloudflare** ← Run workflow. حدود ۵ تا ۸ دقیقه طول می‌کشد: آزمون‌ها، ساخت، سپس deploy. اگر آزمونی شکست بخورد **چیزی منتشر نمی‌شود**.

۷. در **صفحهٔ همان اجرا** (بالای صفحه، بخش Summary) نوشته می‌شود: «AMIN CHAT is live: https://amin-chat.‹زیردامنهٔ-شما›.workers.dev». همان آدرس شماست. workflow خودش هم `/api/health` را تا چند دقیقه می‌آزماید.

اولین اجرا پایگاه داده (`amin-chat-db`) و سطل فایل (`amin-chat-files`) را می‌سازد؛ Wrangler آن‌ها را **با نام** پیدا می‌کند، پس اجرای دوباره یا وجود قبلی‌شان چیزی را دوبار نمی‌سازد. از اجرای دوم به بعد، مهاجرت‌ها **قبل** از کد جدید اجرا می‌شوند.

## راه ب: از رایانهٔ خودتان

```bash
git clone https://github.com/amingangmanatgh2-hash/ck-jigar.git && cd ck-jigar
git checkout Main                 # بعد از Merge؛ تا آن موقع: شاخهٔ arena/4651dc1b-ck-jigar
npm ci
npx wrangler login                # مرورگر باز می‌شود؛ یا CLOUDFLARE_API_TOKEN و CLOUDFLARE_ACCOUNT_ID را در محیط بگذارید
npm run deploy                    # از ریشهٔ مخزن
npm run deploy -- --dry-run       # فقط برنامه را چاپ می‌کند، به Cloudflare وصل نمی‌شود
```

`npm run deploy` این کارها را به ترتیب می‌کند و هر مرحله‌ای که شکست بخورد، بعدی‌ها اجرا **نمی‌شوند**:

1. از Cloudflare می‌پرسد پایگاه داده `amin-chat-db` هست یا نه (`wrangler d1 list`). اگر نتواند بپرسد (توکن غلط، نبودن اینترنت) **هیچ‌چیز نمی‌سازد و منتشر نمی‌کند** و می‌گوید چه چیزی را بررسی کنید.
2. برنامهٔ وب را می‌سازد.
3. **اولین بار** (پایگاه داده نیست): اول `wrangler deploy` (Wrangler پایگاه داده و سطل فایل را می‌سازد)، بعد مهاجرت‌ها.
   **دفعه‌های بعد:** اول مهاجرت‌های D1 (`0001_init`، `0002_file_tiers`، `0003_client_ids`)، بعد `wrangler deploy`؛ تا کد جدید هیچ‌وقت با schema قدیمی روبه‌رو نشود.

آدرس چاپ‌شده مثل `https://amin-chat.<شما>.workers.dev` است.

> ذخیره‌کردن `database_id` در `wrangler.jsonc` **لازم نیست**. (من در منبع wrangler ۴٫۱۶۲٫۰ دیدم که D1 را بدون شناسه هم با نام پیدا می‌کند، چه برای `deploy` و چه برای `d1 migrations apply --remote`. در CI هم شناسه‌ها را به فایل برنمی‌گرداند و لازم هم نیست.)

## تنظیمات (`vars` در `apps/api/wrangler.jsonc`)

| نام | معنی |
|---|---|
| `ADMIN_USERNAMES` | **نام کاربری خودتان** (با کاما برای چند نفر). هر کس با این نام ثبت‌نام کند یا وارد شود مدیر می‌شود (کاربر قبلی هم در **ورود بعدی** ارتقا می‌یابد). نام‌های رزروشده (`admin`، `root`، …) مجاز نیستند |
| `ALLOWED_ORIGINS` | آدرس‌های دیگری که مرورگر از آن‌ها به API درخواست می‌زند (فقط اگر برنامه را جای دیگری میزبانی می‌کنید). خودِ سایت و اپ اندروید داخلی‌اند. هرگز `*` نیست |
| `PUBLIC_ENDPOINTS` | آدرس‌های جایگزین (رله‌ها)؛ [connectivity.md](connectivity.md) |
| `DEFAULT_DAILY_TOKENS`، `DEFAULT_DAILY_REQUESTS`، `DEFAULT_MONTHLY_TOKENS` | سهمیهٔ پیش‌فرض هر کاربر |
| `AI_GATEWAY_ID` | اگر از AI Gateway استفاده می‌کنید |
| `FILES_OFFLOAD_*`، `R2_SOFT_LIMIT_BYTES`، `DRIVE_FOLDER_NAME` | [storage-drive.md](storage-drive.md) |

## Secretهای اختیاری (یک بار، روی خود Cloudflare)

```bash
cd apps/api
npx wrangler secret put RELAY_SECRET            # فقط اگر رله دارید
npx wrangler secret put SEARCH_PROVIDER         # brave یا tavily: جستجوی وب برای دستیار پژوهشگر
npx wrangler secret put SEARCH_API_KEY
# Google Drive (فایل‌های قدیمی را به Drive می‌برد): docs/storage-drive.md
```

بدون `SEARCH_*`، دستیار پژوهشگر صادقانه می‌گوید جستجوی وب وصل نیست و منبع جعل نمی‌کند. این Secretها از GitHub لمس نمی‌شوند و با هر deploy می‌مانند. Secret را بعد از اولین deploy بگذارید (پیش از آن Worker وجود ندارد).

## آدرس اختصاصی (توصیه می‌شود)

در داشبورد Cloudflare: Workers & Pages ← `amin-chat` ← Settings ← Domains & Routes ← Add ← Custom domain. (دامنه باید در همان حساب Cloudflare باشد.) سپس همان آدرس را در ورودی `smoke_url` workflow بدهید تا آزموده شود. توجه: گزارش‌ها می‌گویند در بعضی اپراتورهای ایران هم `workers.dev` و هم دامنهٔ شخصی روی Cloudflare کند یا قطع‌اند؛ [connectivity.md](connectivity.md) را ببینید.

## بررسی پس از راه‌اندازی

۱. `curl https://آدرس-شما/api/health` ← باید `{"ok":true,"service":"amin-chat",…}` بدهد.
۲. در مرورگر آدرس را باز کنید و با **همان نام کاربری `ADMIN_USERNAMES`** ثبت‌نام کنید. مخاطب «AMIN AI» با تیک تأیید خودکار در فهرست گفتگوها هست.
۳. **اتصال واقعی Workers AI:** منوی «مدل‌ها و مصرف» ← دکمهٔ «بررسی دسترس‌پذیری» (فقط مدیر؛ هر مدل را با یک فراخوانی کوچک واقعی می‌سنجد). یا از رایانهٔ خودتان:
   ```bash
   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run verify:ai
   ```
   (توکن با دسترسی «Workers AI: Read»؛ چند نورون از سهمیهٔ رایگان مصرف می‌شود. همین کار از GitHub Actions هم در دسترس است: workflow «Verify Workers AI».) این اسکریپت **همهٔ مدل‌ها را با همان پارامترهایی که برنامه می‌فرستد** صدا می‌زند. در محیط ساخت این کار ممکن نبود، پس شکل دقیق پاسخ‌های استریم، `usage`، و ورودی/خروجی Whisper و Flux **تأییدنشده** است؛ اگر چیزی نخواند، همین‌جا معلوم می‌شود.
۴. یک پیام به AMIN AI بفرستید و ببینید جواب کلمه‌به‌کلمه می‌آید.
۵. **CPU:** داشبورد Cloudflare ← Workers & Pages ← `amin-chat` ← Metrics ← CPU time (p99) و Errors (وضعیت «Exceeded CPU Time Limits» نباید دیده شود). ثبت‌نام و ورود سنگین‌ترین درخواست‌ها هستند.

## به‌روزرسانی

با GitHub Actions: دوباره «Deploy to Cloudflare» را اجرا کنید. از رایانه:

```bash
git pull && npm ci && npm run deploy
```

مهاجرت‌ها فقط **رو به جلو** هستند (بدون برگشت). پیش از به‌روزرسانی‌ای که مهاجرت جدید دارد، از پایگاه داده نسخهٔ پشتیبان بگیرید:
`cd apps/api && npx wrangler d1 export amin-chat-db --remote --output ../../backup.sql`. (Cloudflare امکان بازگردانی به یک زمان قبلی هم دارد: «D1 Time Travel».) برگرداندن کد: `npx wrangler rollback` در `apps/api`.

## چرا دکمهٔ «Deploy to Cloudflare» یک‌کلیکی نیست؟

مستندات Cloudflare می‌گوید این دکمه monorepo را کامل پشتیبانی نمی‌کند: اگر آدرس به یک زیرپوشه اشاره کند، برنامه باید **با همهٔ وابستگی‌هایش** درون همان زیرپوشه باشد، وگرنه build شکست می‌خورد. این پروژه workspace است (`apps/api` به `packages/shared` و ساخت `apps/web` نیاز دارد)، پس دکمه‌ای نگذاشتم که بدانم خراب می‌شود. راه الف همان راحتی را با پایداری بیشتر می‌دهد.

## اجرای محلی برای توسعه

```bash
npm run dev:api            # Worker + D1 + R2 + DO محلی روی ‎:8787، با Workers AI واقعی (نیاز به: npx wrangler login؛ این فراخوانی‌ها از سهمیهٔ حساب شما مصرف می‌شوند)
npm run dev:api:offline    # بدون اتصال به Cloudflare؛ هر قابلیت هوش مصنوعی خطای AI_NOT_CONNECTED می‌دهد (چیزی ساختگی تولید نمی‌شود)
npm run dev:web            # Vite روی ‎:5173، /api را به Worker محلی می‌فرستد
```

کاربر مدیر در حالت محلی: `dev_admin`. حالت محلی با Worker واقعی در Cloudflare بسیار نزدیک است ولی **محدودیت CPU را اعمال نمی‌کند**، پس مشکل ۱۱۰۲ فقط روی Cloudflare دیده می‌شود.

## عیب‌یابی

| نشانه | علت و راه‌حل |
|---|---|
| «Could not ask Cloudflare which databases exist» | توکن غلط/منقضی است، `CLOUDFLARE_ACCOUNT_ID` نیست، یا توکن دسترسی D1 ندارد (قالب Edit Cloudflare Workers + **D1: Edit**). هیچ‌چیز ساخته یا منتشر نشده است |
| خطای ثبت زیردامنهٔ workers.dev هنگام deploy | یک بار داشبورد ← Workers & Pages را باز کنید و یک زیردامنه انتخاب کنید |
| خطای دسترسی R2 | R2 باید در حساب فعال باشد (داشبورد ← R2 ← Enable؛ ممکن است روش پرداخت بخواهد) و توکن **Workers R2 Storage: Edit** داشته باشد |
| خطای ۱۱۰۲ / «Worker exceeded resource limits» | پلن رایگان؛ به Workers Paid بروید |
| خطای ۱۰۲۷ | سقف ۱۰۰٬۰۰۰ درخواست در روز در پلن رایگان |
| `AI_NOT_CONNECTED` | بایندینگ `AI` نیست (حالت offline، یا wrangler.jsonc دست‌کاری شده) |
| مدل «در دسترس نیست» با دلیل `check_failed` یا `unverified` | یک مدل خطا داده (۲۰ دقیقه کنار می‌رود) یا هنوز بررسی نشده؛ دکمهٔ بررسی را بزنید. اگر همیشه شکست می‌خورد، به `npm run verify:ai` نگاه کنید |
| ورود از مرورگر دیگر ← خطای CORS | آدرس آن را به `ALLOWED_ORIGINS` بیفزایید |
| مدیر نیستم | نام کاربری را به `ADMIN_USERNAMES` بیفزایید، دوباره deploy کنید و **خارج و دوباره وارد شوید** (ارتقا هنگام ورود انجام می‌شود) |
| دکمهٔ «Run workflow» نیست | workflow در شاخهٔ پیش‌فرض نیست؛ Pull Request را Merge کنید |

</div>
