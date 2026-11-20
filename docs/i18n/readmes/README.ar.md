# Aa Browser

**متصفح سطح المكتب المصمَّم من الأساس للوكلاء — مفتوح المصدر بترخيص MIT.**

<p align="center">
  <a href="../../../README.md">简体中文</a> ·
  <a href="./README.en.md">English</a> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.pt-BR.md">Português (BR)</a> ·
  <a href="./README.fr.md">Français</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.ru.md">Русский</a> ·
  <b>العربية</b> ·
  <a href="./README.hi.md">हिन्दी</a>
</p>

![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey) ![MCP](https://img.shields.io/badge/protocol-MCP-purple)

> متصفح تستخدمه أنت كإنسان، ويقوده الوكيل كمهندس.

<p align="center">
  <img src="../../../site/assets/og-image.png" alt="Aa Browser — a browser built for agents" width="720" />
</p>

هذه **ترجمة مختصرة**. التوثيق الكامل والمرجعي مكتوب بالصينية: [README.md](../../../README.md) و[`docs/`](../../).

## ما هو

صُمِّمت المتصفحات التقليدية لعيون بشرية تنظر إلى البكسلات؛ أما وكيل الذكاء الاصطناعي فيحتاج إلى **بيانات صفحة مُهيكَلة**. Aa Browser متصفح سطح مكتب كامل مبني على Chromium (Electron) يمكن لأي شخص استخدامه بشكل طبيعي — علامات تبويب، شريط عناوين، سجل، تنزيلات، بحث داخل الصفحة، وجلسات دخول دائمة — ويكشف الصفحة لأي وكيل [MCP](https://modelcontextprotocol.io) عبر جسر stdio محلي: قراءة **لقطة إتاحة مُهيكَلة**، ثم النقر والكتابة والاختيار والسحب والتمرير والاستخراج والتقاط حركة الشبكة. بلا لقطات شاشة وبلا تخمين إحداثيات.

اللقطات **تزايدية** افتراضيًا: الصفحة غير المتغيّرة تكلّف سطرًا واحدًا، والتغييرات الصغيرة تُعيد الفرق فقط، وتبقى معرّفات `ref` مستقرة بين اللقطات المتتالية. يستمع الجسر على `127.0.0.1` برمز يُنشأ عند كل تشغيل ويُخزَّن في `~/.aabrowser/connection.json`.

## أبرز الميزات

- 🖥️ **متصفح حقيقي**: هيكل Electron/Chromium مع علامات تبويب وشريط عناوين وأزرار رجوع/تقدّم وبحث داخل الصفحة ولوحة تنزيلات وجلسات دخول دائمة.
- 🧠 **لقطات مُهيكَلة**: تتحوّل الصفحة إلى شجرة إتاحة بأسلوب YAML يحمل فيها كل عنصر تفاعلي معرّف `ref` (`- button "Sign in" [ref=e5]`)، بما يتوافق مع صيغة Playwright MCP.
- 💸 **اللقطات التزايدية توفّر الرموز**: لا تغيير → سطر واحد؛ تغيير صغير → الكتل المتغيّرة فقط؛ الانتقال أو التغييرات الكبيرة → لقطة كاملة. والمهام الطويلة توفّر عادةً 60%+ من السياق.
- 🎯 **مسار إدخال حقيقي**: النقر يستخدم أحداث إدخال موثوقة (`isTrusted=true`)، والكتابة تمرّ عبر مسار `insertText` مع بديل لحقول React المُدارة، والأحداث الاصطناعية تغطي الحالة النادرة التي يُفقد فيها الحدث الحقيقي.
- 🤖 **MCP أصلي**: جسر stdio MCP قياسي؛ يمكن لـ Codex وZCode وClaude Code وCursor وWindsurf وCline وVS Code وGemini CLI وQwen Code وWorkBuddy قيادته.
- 📊 **التشخيص**: يُعيد `browser_performance` أزمنة التنقل وأول رسم وأحجام الموارد والموارد البطيئة وكومة JS وحجم DOM دون فتح DevTools.
- 🌐 **واجهة ثنائية اللغة**: تتبع لغة النظام أو المتصفح، أو يمكن تثبيت الصينية المبسطة / الإنجليزية في الإعدادات.
- 🔒 **أمان محلي أولًا**: WebSocket على loopback فقط، ورمز عشوائي عند كل تشغيل، وقائمة مواقع مسموحة، وعلامات تبويب معزولة، وبيانات شبكة مُعقَّمة، وموافقة داخل المتصفح للعمليات عالية المخاطر.
- 📦 **إصدارات قابلة للتحقق**: يصدر Windows NSIS وLinux AppImage بالنسخة نفسها مع `SHA256SUMS.txt` وشهادات إصدار GitHub غير القابلة للتغيير وملف CycloneDX باسم `sbom.cdx.json`.

## مثال على اللقطة

استدعاء `browser_snapshot` على الصفحة الرئيسية لـ Bing يُعيد (مخرجات حقيقية، منقولة حرفيًا):

```text
页面快照 url: https://www.bing.com/
title: 搜索 - Microsoft 必应
元素数: 19

- banner "登录 Rewards 手机版"
  - img "必应"
  - navigation
    - menuitem "图片" [ref=e1]
    - menuitem "视频" [ref=e3]
- search
  - combobox "搜索网页" [ref=e15]
  - button "语音搜索" [ref=e16]
```

ثم يعمل الوكيل على `ref`:

```jsonc
{ "tool": "browser_type", "arguments": { "ref": "e15", "text": "Aa Browser", "submit": true } }
```

بعد أي إجراء تحصل على **لقطة تزايدية** — الكتل المتغيّرة فقط، إضافةً إلى معرّفات `ref` التي أُضيفت أو أُبطلت. و`browser_snapshot { full: true }` يفرض الشجرة الكاملة.

## التثبيت

### أمر واحد (موصى به)

أرسل الأمر النصي الموجود في [PROMPT.md](../../../PROMPT.md) إلى أي ذكاء اصطناعي قادر على تنفيذ أوامر محلية. إذا لم يكن Aa Browser مثبتًا بعد، فإنه ينزّل المثبّت الرسمي ويتحقق من SHA-256 ويثبّت ويشغّل ويكتب إعداد MCP ويستدعي `browser_tabs` فعليًا للتحقق. وإذا كان Aa Browser يعمل بالفعل، فإنه يكتب الإعداد فقط ثم يتحقق منه.

```bash
node install.mjs --repo yuchen0x1/aa-browser --verify --json   # download, verify, install, connect, verify
node install.mjs --connect-only --verify --json                 # already installed: connect and verify only
node install.mjs --verify-only                                  # verify the browser side, write nothing
node install.mjs --print-config                                 # print a generic MCP config fragment (pure JSON)
```

المثبّت لا يطرح أسئلة تفاعلية أبدًا. `--clients zcode,cursor` يحدّد العملاء الذين ستُهيَّأ، و`--dir <dir>` يتجاوز مجلد التثبيت، و`--no-launch` يتخطى التشغيل، و`--sha256 <hex>` يثبّت بصمة المثبّت المتوقعة. ويمكن لأي عميل MCP آخر استخدام مخرجات `--print-config`.

### Windows

نزّل `aa-browser-setup-<version>.exe` من [GitHub Releases](https://github.com/yuchen0x1/aa-browser/releases/latest) وشغّله. المثبّت **غير موقّع برمجيًا**: عند ظهور SmartScreen اختر «مزيد من المعلومات ← تشغيل على أي حال». يتضمن كل إصدار أيضًا `SHA256SUMS.txt` و`sbom.cdx.json` وشهادة إصدار غير قابلة للتغيير كي تتحقق من الملفات بنفسك.

### Linux AppImage

نزّل `aa-browser-<version>-linux-x86_64.AppImage`، واجعله قابلًا للتنفيذ، وشغّله من جلسة سطح المكتب الحالية. يلزم GTK 3 وNSS وGBM ومكتبات الصوت وبيئة عزل Chromium عاملة؛ ويحتاج الوصول عبر MCP إلى Node.js نظام بإصدار 22.12 أو أحدث.

```bash
mkdir -p ~/Applications
mv aa-browser-<version>-linux-x86_64.AppImage ~/Applications/AaBrowser.AppImage
chmod u+x ~/Applications/AaBrowser.AppImage
~/Applications/AaBrowser.AppImage
```

بدون FUSE شغّله بـ `APPIMAGE_EXTRACT_AND_RUN=1 ~/Applications/AaBrowser.AppImage`. راجع [دليل المنصّات](../../../docs/PLATFORMS.md) لحالة كل توزيعة وخطوات الاستعادة.

### من الشيفرة المصدرية

يلزم Node.js 22.12 أو أحدث.

```bash
git clone https://github.com/yuchen0x1/aa-browser.git aa-browser
cd aa-browser
npm ci             # downloads Electron on first run
npm run build      # main, preload, renderer, MCP bridge and DeepSeek Harness plugin bridge
npm start          # launch the built app
```

وضع التطوير مع إعادة تحميل الواجهة فوريًا هو `npm run dev`؛ ويستخدم مجلد بيانات مستخدم منفصلًا `aa-browser-dev`، لذا يمكنه العمل إلى جانب النسخة المثبتة.

## توصيل الوكيل

المتطلبات المسبقة: أن يكون Aa Browser قيد التشغيل (فهو يكتب المنفذ والرمز إلى `~/.aabrowser/connection.json`)، وأن يدعم العميل stdio MCP، وأن يعمل كلاهما بالمستخدم نفسه على الجهاز نفسه.

- **بنقرة واحدة**: الإعدادات → توصيل عميل الذكاء الاصطناعي → تحديد العملاء → كتابة. ثم أعد تشغيل العميل.
- **يدويًا**: شغّل `node install.mjs --print-config` وألصق `command` / `args` / `env` المطبوعة في إعداد العميل. تُنسخ الإعدادات القائمة احتياطيًا إلى `<file>.aa-backup-<timestamp>`؛ ولا يُعدَّل إلا مدخل `aa-browser`، والكتابة قابلة للتكرار دون أثر مكرّر (idempotent).

### الحالة والتحقق

| حالة شريط الأدوات | المعنى |
| --- | --- |
| في انتظار اتصال الذكاء الاصطناعي | لم يتصل أي جسر MCP: الإعداد غير مكتوب، أو العميل لم يُعَد تشغيله، أو المتصفح لا يعمل |
| في انتظار أول استدعاء | الجسر متصل ومصادَق عليه، لكن لم ينجح أي استدعاء أداة بعد |
| الذكاء الاصطناعي متصل ×N | نجح استدعاء قائمة `browser_tabs` مرة واحدة على الأقل؛ وN هو عدد الجسور التي تم التحقق منها |

الإعداد المكتوب **ليس** اتصالًا عاملًا. تحقّق بـ `node install.mjs --verify-only`، أو دع الوكيل يستدعي `browser_tabs` فعليًا.

## أدوات MCP

**42 أداة** في خمس مجموعات: التنقل واللقطات (5)، والتفاعل (9)، والقراءة والحالة (19)، والشبكة وMock (6)، والتشخيص وعلامات التبويب (3). قد تحمل أسماء الأدوات في العميل بادئة `mcp__aa-browser__`.

| المجموعة | الأدوات |
| --- | --- |
| التنقل واللقطات | `browser_navigate`, `browser_snapshot`, `browser_navigate_back`, `browser_navigate_forward` |
| التفاعل | `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_drag`, `browser_hover`, `browser_scroll`, `browser_press_key`, `browser_upload_file` |
| القراءة والحالة | `browser_extract`, `browser_evaluate`, `browser_dialogs`, `browser_wait`, `browser_screenshot`, `browser_find`, `browser_get_selector`, `browser_cookies`, `browser_storage`, `browser_downloads`, `browser_pdf`, `browser_console` |
| الشبكة وMock | `browser_network_requests`, `browser_network_detail`, `browser_har`, `browser_mock_requests`, `browser_list_mocks`, `browser_clear_mocks` |
| التشخيص وعلامات التبويب | `browser_performance`, `browser_resize`, `browser_tabs` |

السلوك المشترك: معظم الأدوات تُعيد لقطة مع نتيجتها (`snapshot: false` يتخطاها)، وكل أداة عدا `browser_resize` و`browser_downloads` تقبل `tabId`، وينتهي الاستدعاء الواحد بمهلة بعد 180 ثانية، وتنتظر الموافقة حتى 120 ثانية، وتُعقَّم تفاصيل الشبكة افتراضيًا. الدليل الكامل للأدوات في [site/tools.html](../../../site/tools.html).

## الأمان

- خدمة الوكيل تستمع على `127.0.0.1` فقط، وتستخدم رمزًا عشوائيًا عند كل تشغيل، وترفض المصادر غير المحلية؛ ويُخزَّن المنفذ والرمز في `~/.aabrowser/connection.json` ويُحذفان عند الخروج السليم.
- تعمل عروض الصفحات دون سكربت preload؛ ويُحقن الوكيل الرئيسي اللقطات وسكربتات الإجراءات. لا يسمح التنقل إلا بـ `http:` / `https:` — وتُرفض بروتوكولات `file:` و`data:` و`devtools:` وما شابهها.
- يجب أن يملأ المستخدم حقول الإدخال الحساسة بنفسه: فالنص الذي يقدمه الوكيل لا يُكتب ولا يُقرأ ولا يُعاد أبدًا. ومع تفعيل «تأكيد العمليات عالية المخاطر»، تنتظر إرسال النماذج والضغط على Enter بعد الكتابة والوصول إلى بيانات شبكة غير مُعقَّمة موافقةً داخل المتصفح (120 ثانية، ثم تُعامَل كرفض).
- تُعقَّم تفاصيل الشبكة وتصديرات HAR افتراضيًا من ترويسات المصادقة والمعاملات الشبيهة ببيانات الاعتماد.
- **قائمة المواقع المسموحة**: تنطبق على التنقل فقط؛ وتركها فارغة يعني تعطيلها، وحتى وهي فارغة تبقى `file:` و`data:` و`devtools:` وغيرها من البروتوكولات غير الشبكية محظورة.
- **توصيل الوكيل يعدّل مدخلًا واحدًا فقط**: تُنسخ إعدادات العملاء القائمة احتياطيًا أولًا، ولا يُعدَّل إلا مدخل `aa-browser`، ولا يُكتب أي token أو كلمة مرور أبدًا، وتتحقق تنزيلات المثبّت من digest SHA-256 للإصدار ومن ترويسة الملف.
- تستخدم علامات التبويب المعزولة قسم جلسة منفصلًا: بلا مشاركة ملفات تعريف الارتباط أو جلسات الدخول، وتُمسح عند الإغلاق، وتُستبعد من السجل العام وقائمة المغلقة حديثًا واستعادة الجلسة.
- **الحدود**: يستطيع الوكيل رؤية محتوى الصفحة وحركة الشبكة، بما في ذلك ملفات تعريف الارتباط والتخزين والترويسات وأجسام الاستجابات. هذه الضوابط تخفيف للمخاطر وليست DLP عامًا — لا توجّه وكيلًا غير موثوق إلى مواقع عالية الحساسية.

أبلغ عن الثغرات عبر الإبلاغ الخاص في [SECURITY.md](../../../SECURITY.md)، ولا تفعل ذلك في issue عام أبدًا.

## المنصّات والحدود

| المنصّة | البناء الرسمي | ملاحظات |
| --- | --- | --- |
| Windows 11 x64 | مثبّت NSIS | يُصان بنشاط، ومغطّى بـ CI والاختبارات المحلية |
| Windows 10 x64 | المثبّت نفسه | يتشارك بناء Windows 11؛ ولا يزال قبول الترقية على جهاز حقيقي معلّقًا |
| Linux x86_64 (سطح مكتب Ubuntu) | AppImage | يحتاج Node.js نظام بإصدار 22.12+؛ والتوزيعات الأخرى تحتاج تحققًا على جهاز حقيقي |
| Windows ARM64 / macOS / Android / iOS | لا يوجد | يرفض المثبّت صراحةً بدل الإيهام بالتثبيت |

قيود معروفة:

- **لا توقيع برمجي** على Windows: يحذّر SmartScreen ويتطلب «مزيد من المعلومات ← تشغيل على أي حال».
- **ليس بديلًا عن Chrome**: لا إشارات مرجعية ولا إضافات ولا مزامنة حساب أو متعدد الأجهزة. النطاق هو «نواة المتصفح + وصول الوكيل».
- **الوصول عبر MCP في Linux يتطلب Node.js نظام 22.12+**؛ وفي Windows يُستخدم وقت التشغيل المضمَّن عند عدم العثور على Node نظامي.
- **استعادة الجلسة محدودة النطاق**: علامات تبويب ويب عادية فقط، وبحد أقصى 20 مدخلًا، ولا تشمل أبدًا العلامات المعزولة أو الصفحات الداخلية أو عناوين غير HTTP(S).
- **مثيل واحد لكل مجلد بيانات مستخدم**؛ وبناء التطوير يستخدم مجلده الخاص كي يعمل الاثنان معًا.
- **التثبيت والتحديثات تعتمد على GitHub Releases**؛ والتحديث الذاتي لـ AppImage يحتاج مجلدًا قابلًا للكتابة.

## التوثيق

التوثيق التفصيلي حاليًا باللغة الصينية:

| المستند | المحتوى |
| --- | --- |
| [docs/CONNECT.md](../../../docs/CONNECT.md) | مصفوفة المنصّات والعملاء، وخيارات المثبّت، والخطوات اليدوية، واستكشاف الأخطاء |
| [docs/PLATFORMS.md](../../../docs/PLATFORMS.md) | مصفوفة الإصدارات، وتبعيات Linux، وإزالة التثبيت واستعادة البيانات |
| [docs/AUTO_UPDATE.md](../../../docs/AUTO_UPDATE.md) | فحص التحديث والتنزيل وإعادة التشغيل للتثبيت وSHA-512 والتراجع |
| [docs/MARKETPLACE.md](../../../docs/MARKETPLACE.md) | تثبيت إضافة DeepSeek Harness والتحقق منها |
| [docs/MAINTENANCE.md](../../../docs/MAINTENANCE.md) | أدلة الإصدار وسجلات الاختبارات وحدود الصيانة |
| [ملاحظات الإصدار](../../../docs/releases/release-notes.md) / [CHANGELOG](../../../CHANGELOG.md) | سجل التغييرات حسب الإصدار |
| [site/tools.html](../../../site/tools.html) | الدليل الكامل للأدوات الـ42 (يُفتح محليًا دون حاجة إلى نشر) |

## المساهمة والترخيص

نرحّب بتقارير الأخطاء ونقاشات الميزات وتصحيحات التوثيق وطلبات السحب (PR) — يُرجى قراءة [CONTRIBUTING.md](../../../CONTRIBUTING.md) أولًا. وعند إضافة أداة MCP، حدّث `src/main/tools.ts` و`cli/mcp.mjs` وجدول الأدوات في هذا الملف و`site/tools.html` معًا؛ ويتحقق `npm run check` من بقاء الثلاثة الأولى متزامنة.

MIT licensed — راجع [LICENSE](../../../LICENSE) © Aa Browser contributors.

قد تتأخر هذه الترجمة عن النص الصيني الأصلي. تُصان ترجمات هذا الملف في [README.md](../../../README.md) (简体中文) إضافةً إلى ملفات `docs/i18n/readmes/README.<language>.md`؛ والقائمة الكاملة في `../readme-languages.json`.
