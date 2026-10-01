# 🤖 بوت تليجرام لاستخراج الترجمات والخطوط (Telegram Subtitle Extractor)

دليل خطوة بخطوة لربط بوت تليجرام بمستودع GitHub وتشغيله مجاناً وبدون أي سيرفر عبر **Cloudflare Workers** (يعمل 24/7 للأبد).

---

## 📋 المتطلبات البسيطة:
1. حساب تليجرام.
2. حساب GitHub.
3. حساب [Cloudflare](https://dash.cloudflare.com/) (مجاني بالكامل).

---

## 🛠️ خطوات الإعداد (5 دقائق فقط):

### الخطوة 1: إنشاء بوت تليجرام
1. افتح تليجرام وتوجه إلى [@BotFather](https://t.me/BotFather).
2. أرسل الأمر `/newbot`.
3. اختر اسماً للبوت، ثم اختر اسم مستخدم ينتهي بـ `bot` (مثال: `MySubExtractor_bot`).
4. سيعطيك BotFather **توكن البوت (Token)**، سيكون بشكـل مشابه لـ:
   `1234567890:ABCdefGhIJKlmNoPQRsTUVwxyZ`
   احفظ هذا التوكن.

---

### الخطوة 2: استخراج رمز وصول GitHub (GitHub PAT)
لكي يستطيع البوت إعطاء أمر لسيرفرات GitHub Actions ببدء التحميل والاستخراج:
1. اذهب إلى [GitHub Personal Access Tokens (Classic)](https://github.com/settings/tokens).
2. اضغط على **Generate new token (classic)**.
3. في خانة **Note** اكتب: `Telegram Bot Extractor`.
4. في خانة **Expiration** اختر: `No expiration` (أو المدة التي تفضلها).
5. في قائمة الصلاحيات (Scopes)، ضع علامة صح أمام:
   - ✅ **repo** (التحكم الكامل بالمستودع)
   - ✅ **workflow** (لتشغيل الـ Actions)
6. انزل لأسفل واضغط **Generate token**، وانسخ الرمز الناتج (يبدأ عادة بـ `ghp_...`).

---

### الخطوة 3: إضافة التوكن إلى أسرار مستودع GitHub
لكي يستطيع سيرفر GitHub إرسال ملف الـ ZIP النهائي إلى تليجرام:
1. اذهب لصفحة مستودعك على GitHub:
   `https://github.com/NewKazuha/sub-extractor/settings/secrets/actions`
2. اضغط على زر **New repository secret**.
3. في خانة **Name** اكتب: `TELEGRAM_BOT_TOKEN`
4. في خانة **Secret** ضع توكن البوت الذي حصلت عليه من BotFather.
5. اضغط **Add secret**.

---

### الخطوة 4: تشغيل كود البوت على Cloudflare Workers (مجاناً)
1. سجل دخول إلى [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. من القائمة الجانبية، اختر **Workers & Pages** ثم اضغط **Create application** -> **Create Worker**.
3. اختر اسماً للوركر (مثلاً: `sub-extractor-bot`) واضغط **Deploy**.
4. اضغط على **Edit code**.
5. احذف الكود الافتراضي بالكامل، وانسخ محتوى ملف [`worker.js`](worker.js) وضعه مكانه، ثم اضغط **Deploy**.
6. ارجع إلى صفحة الوركر الرئيسية، واذهب إلى تبويب **Settings** -> **Variables and Secrets**.
7. أضف المتغيرات التالية بالضغط على **Add**:
   - `TELEGRAM_BOT_TOKEN`: توكن البوت من BotFather.
   - `GITHUB_PAT`: التوكن الذي استخرجته في الخطوة 2 (`ghp_...`).
   - `GITHUB_OWNER`: اسم حسابك على GitHub (مثال: `NewKazuha`).
   - `GITHUB_REPO`: اسم المستودع (مثال: `sub-extractor`).
   - `ALLOWED_CHAT_ID`: *(اختياري ولكنه موصى به)* رقم الـ Chat ID الخاص بك في تليجرام لحماية البوت من أن يستخدمه غيرك (يمكنك معرفة الـ ID الخاص بك عند إرسال `/start` للبوت).
8. اضغط **Save and Deploy**.

---

### الخطوة 5: ربط البوت بالوركر (تفعيل الـ Webhook)
فقط افتح متصفحك وادخل على الرابط التالي:
```text
https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev/set-webhook
```
*(استبدل الرابط برابط الوركر الخاص بك من كلاودفلير)*

ستظهر لك رسالة تأكيد:
```json
{
  "ok": true,
  "result": true,
  "description": "Webhook was set"
}
```

---

## 🎉 مبروك! البوت جاهز تماماً للاستخدام
الآن توجه إلى محادثة البوت على تليجرام:
1. أرسل `/start`.
2. أرسل الرابط متبوعاً بمسافة ثم اسم العمل:
   `https://mega.nz/folder/... هجوم_العمالقة`
3. سيرد البوت فوراً بأنه استلم الرابط واسم العمل وبدأ الاستخراج، وخلال دقائق ستصلك رسالة تحتوي على ملف الـ `.zip` الجاهز المنظم ومكتوب عليه اسم العمل مباشرة!
