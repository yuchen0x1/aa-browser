# Aa Browser

**एजेंट-नेटिव डेस्कटॉप ब्राउज़र — ओपन सोर्स, MIT लाइसेंस।**

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
  <a href="./README.ar.md">العربية</a> ·
  <b>हिन्दी</b>
</p>

![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Windows%20x64%20%7C%20Linux%20x86_64-lightgrey) ![MCP](https://img.shields.io/badge/protocol-MCP-purple)

> ऐसा ब्राउज़र जिसे आप इंसान की तरह इस्तेमाल करते हैं, और एजेंट उसे इंजीनियर की तरह चलाता है।

<p align="center">
  <img src="../../../docs/media/aa-browser-demo.webp" alt="Aa Browser — a browser built for agents" width="720" />
</p>

यह एक **संक्षिप्त अनुवाद** है। पूरा और आधिकारिक दस्तावेज़ चीनी भाषा में लिखा गया है: [README.md](../../../README.md) और [`docs/`](../../)।

## यह क्या है

पारंपरिक ब्राउज़र उन इंसानी आँखों के लिए बनाए गए हैं जो पिक्सेल देखती हैं; AI एजेंट को **संरचित पेज डेटा** चाहिए। Aa Browser एक पूरा Chromium डेस्कटॉप ब्राउज़र (Electron) है जिसे कोई भी सामान्य रूप से इस्तेमाल कर सकता है — टैब, ओम्नीबॉक्स, इतिहास, डाउनलोड, पेज में खोज, और टिकाऊ लॉगिन — और यह किसी भी [MCP](https://modelcontextprotocol.io) एजेंट के लिए पेज को एक स्थानीय stdio ब्रिज के ज़रिए खोल देता है: **संरचित एक्सेसिबिलिटी स्नैपशॉट** पढ़ें, फिर क्लिक करें, टाइप करें, चुनें, ड्रैग करें, स्क्रॉल करें, डेटा निकालें और ट्रैफ़िक कैप्चर करें। न स्क्रीनशॉट, न अनुमानित निर्देशांक।

स्नैपशॉट डिफ़ॉल्ट रूप से **इंक्रीमेंटल** हैं: न बदला हुआ पेज एक पंक्ति का होता है, छोटे बदलाव सिर्फ़ डिफ़ लौटाते हैं, और `ref` आईडी स्नैपशॉट के बीच स्थिर रहती हैं। ब्रिज `127.0.0.1` पर सुनता है और हर लॉन्च पर बनाया गया टोकन `~/.aabrowser/connection.json` में रखा जाता है।

## मुख्य विशेषताएँ

- 🖥️ **असली ब्राउज़र**: Electron/Chromium शेल — टैब, ओम्नीबॉक्स, आगे/पीछे, पेज में खोज, डाउनलोड पैनल और टिकाऊ लॉगिन।
- 🧠 **संरचित स्नैपशॉट**: पेज YAML शैली के एक्सेसिबिलिटी ट्री में बदल जाता है, जहाँ हर इंटरैक्टिव एलिमेंट पर एक `ref` आईडी होती है (`- button "Sign in" [ref=e5]`), जो Playwright MCP के फ़ॉर्मैट से मेल खाती है।
- 💸 **इंक्रीमेंटल स्नैपशॉट टोकन बचाते हैं**: कोई बदलाव नहीं → एक पंक्ति; छोटा बदलाव → सिर्फ़ बदले हुए ब्लॉक; नेविगेशन या बड़े बदलाव → पूरा स्नैपशॉट। लंबे कामों में आम तौर पर 60%+ संदर्भ बचता है।
- 🎯 **असली इनपुट पथ**: क्लिक भरोसेमंद इनपुट इवेंट (`isTrusted=true`) इस्तेमाल करते हैं, टाइपिंग `insertText` पाइपलाइन से होती है और React-नियंत्रित इनपुट के लिए फ़ॉलबैक है, तथा सिंथेटिक इवेंट उस दुर्लभ स्थिति को कवर करते हैं जब असली इवेंट छूट जाए।
- 🤖 **MCP मूल रूप से**: मानक stdio MCP ब्रिज; Codex, ZCode, Claude Code, Cursor, Windsurf, Cline, VS Code, Gemini CLI, Qwen Code और WorkBuddy इसे चला सकते हैं।
- 📊 **डायग्नोस्टिक्स**: `browser_performance` नेविगेशन समय, पहला पेंट, रिसोर्स आकार और धीमे रिसोर्स, JS हीप और DOM आकार लौटाता है — DevTools खोले बिना।
- 🌐 **द्विभाषी UI**: सिस्टम या ब्राउज़र भाषा का अनुसरण करता है, या सेटिंग्स में सरलीकृत चीनी / अंग्रेज़ी तय की जा सकती है।
- 🔒 **लोकल-फ़र्स्ट सुरक्षा**: WebSocket सिर्फ़ लूपबैक पर, हर लॉन्च पर यादृच्छिक टोकन, साइट अनुमति-सूची, अलग-थलग टैब, रीडैक्ट किया गया नेटवर्क डेटा, और जोखिम भरे कामों के लिए ब्राउज़र में मंज़ूरी।
- 📦 **सत्यापन योग्य रिलीज़**: Windows NSIS और Linux AppImage एक ही वर्शन में `SHA256SUMS.txt`, GitHub की अपरिवर्तनीय रिलीज़ अटेस्टेशन और CycloneDX `sbom.cdx.json` के साथ आते हैं।

## स्नैपशॉट उदाहरण

Bing होमपेज पर `browser_snapshot` कॉल करने पर यह मिलता है (असली आउटपुट, ज्यों का त्यों रखा गया):

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

इसके बाद एजेंट किसी `ref` पर काम करता है:

```jsonc
{ "tool": "browser_type", "arguments": { "ref": "e15", "text": "Aa Browser", "submit": true } }
```

किसी क्रिया के बाद आपको **इंक्रीमेंटल स्नैपशॉट** मिलता है — सिर्फ़ बदले हुए ब्लॉक, साथ ही यह भी कि कौन-सी `ref` आईडी जुड़ीं या अमान्य हुईं। `browser_snapshot { full: true }` पूरा ट्री ज़बरदस्ती लौटाता है।

## इंस्टॉल

### एक प्रॉम्प्ट (अनुशंसित)

[PROMPT.md](../../../PROMPT.md) का प्रॉम्प्ट किसी भी ऐसे AI को भेजें जो स्थानीय कमांड चला सकता हो। अगर Aa Browser अभी इंस्टॉल नहीं है, तो यह आधिकारिक इंस्टॉलर डाउनलोड करता है, SHA-256 जाँचता है, इंस्टॉल और लॉन्च करता है, MCP कॉन्फ़िग लिखता है और सत्यापन के लिए सचमुच `browser_tabs` कॉल करता है। अगर Aa Browser पहले से चल रहा है, तो यह सिर्फ़ कॉन्फ़िग लिखता है और सत्यापन करता है।

```bash
node install.mjs --repo yuchen0x1/aa-browser --verify --json   # download, verify, install, connect, verify
node install.mjs --connect-only --verify --json                 # already installed: connect and verify only
node install.mjs --verify-only                                  # verify the browser side, write nothing
node install.mjs --print-config                                 # print a generic MCP config fragment (pure JSON)
```

इंस्टॉलर कभी इंटरैक्टिव सवाल नहीं पूछता। `--clients zcode,cursor` तय करता है कि कौन-से क्लाइंट कॉन्फ़िगर होंगे, `--dir <dir>` इंस्टॉल डायरेक्टरी बदलता है, `--no-launch` लॉन्च छोड़ देता है, और `--sha256 <hex>` इंस्टॉलर का अपेक्षित हैश तय करता है। कोई भी अन्य MCP क्लाइंट `--print-config` का आउटपुट इस्तेमाल कर सकता है।

### Windows

[GitHub Releases](https://github.com/yuchen0x1/aa-browser/releases/latest) से `aa-browser-setup-<version>.exe` डाउनलोड करके चलाएँ। इंस्टॉलर **कोड-साइन नहीं है**: SmartScreen दिखने पर "अधिक जानकारी → फिर भी चलाएँ" चुनें। हर रिलीज़ के साथ `SHA256SUMS.txt`, `sbom.cdx.json` और एक अपरिवर्तनीय रिलीज़ अटेस्टेशन भी आता है, ताकि आप फ़ाइलें खुद जाँच सकें।

### Linux AppImage

`aa-browser-<version>-linux-x86_64.AppImage` डाउनलोड करें, उसे executable बनाएँ और मौजूदा डेस्कटॉप सत्र से शुरू करें। GTK 3, NSS, GBM, ऑडियो लाइब्रेरी और काम करता Chromium सैंडबॉक्स ज़रूरी हैं; MCP एक्सेस के लिए सिस्टम Node.js 22.12 या नया चाहिए।

```bash
mkdir -p ~/Applications
mv aa-browser-<version>-linux-x86_64.AppImage ~/Applications/AaBrowser.AppImage
chmod u+x ~/Applications/AaBrowser.AppImage
~/Applications/AaBrowser.AppImage
```

FUSE के बिना इसे `APPIMAGE_EXTRACT_AND_RUN=1 ~/Applications/AaBrowser.AppImage` से शुरू करें। वितरण-विशेष स्थिति और रिकवरी के कदम [प्लेटफ़ॉर्म गाइड](../../../docs/PLATFORMS.md) में देखें।

### सोर्स से

Node.js 22.12 या नया चाहिए।

```bash
git clone https://github.com/yuchen0x1/aa-browser.git aa-browser
cd aa-browser
npm ci             # downloads Electron on first run
npm run build      # main, preload, renderer, MCP bridge and DeepSeek Harness plugin bridge
npm start          # launch the built app
```

हॉट-रीलोडिंग रेंडरर वाला डेवलपमेंट मोड `npm run dev` है; यह अलग `aa-browser-dev` यूज़र-डेटा डायरेक्टरी इस्तेमाल करता है, इसलिए यह इंस्टॉल किए गए बिल्ड के साथ-साथ चल सकता है।

## अपना एजेंट जोड़ें

पूर्वापेक्षाएँ: Aa Browser चल रहा हो (यह पोर्ट और टोकन `~/.aabrowser/connection.json` में लिखता है), क्लाइंट stdio MCP सपोर्ट करता हो, और दोनों एक ही मशीन पर एक ही उपयोगकर्ता के रूप में चलें।

- **एक क्लिक**: सेटिंग्स → AI क्लाइंट कनेक्ट करें → क्लाइंट चुनें → लिखें। इसके बाद क्लाइंट को रीस्टार्ट करें।
- **मैन्युअल**: `node install.mjs --print-config` चलाएँ और छपे हुए `command` / `args` / `env` को क्लाइंट कॉन्फ़िग में पेस्ट करें। मौजूदा कॉन्फ़िग `<file>.aa-backup-<timestamp>` में बैकअप हो जाती है; सिर्फ़ `aa-browser` एंट्री बदली जाती है, और लेखन idempotent रहता है।

### स्थिति और सत्यापन

| टूलबार स्थिति | अर्थ |
| --- | --- |
| AI कनेक्शन की प्रतीक्षा | कोई MCP ब्रिज नहीं जुड़ा: कॉन्फ़िग नहीं लिखी गई, क्लाइंट रीस्टार्ट नहीं हुआ, या ब्राउज़र नहीं चल रहा |
| पहले AI कॉल की प्रतीक्षा | ब्रिज जुड़ा और प्रमाणित है, पर अब तक कोई टूल कॉल सफल नहीं हुआ |
| AI जुड़ा ×N | कम से कम एक `browser_tabs` लिस्ट कॉल सफल हुआ; N सत्यापित ब्रिज की संख्या है |

लिखी गई कॉन्फ़िग **काम करता कनेक्शन नहीं** है। `node install.mjs --verify-only` से सत्यापित करें, या एजेंट से सचमुच `browser_tabs` कॉल करवाएँ।

## MCP टूल्स

पाँच समूहों में **47 टूल**: नेविगेशन और स्नैपशॉट (5), इंटरैक्शन (9), रीड और स्टेट (20), नेटवर्क और Mock (6), डायग्नोस्टिक्स और टैब (7)। क्लाइंट में टूल नामों पर `mcp__aa-browser__` प्रीफ़िक्स हो सकता है।

| समूह | टूल |
| --- | --- |
| नेविगेशन और स्नैपशॉट | `browser_navigate`, `browser_snapshot`, `browser_navigate_back`, `browser_navigate_forward` |
| इंटरैक्शन | `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_drag`, `browser_hover`, `browser_scroll`, `browser_press_key`, `browser_upload_file` |
| रीड और स्टेट | `browser_extract`, `browser_evaluate`, `browser_dialogs`, `browser_wait`, `browser_screenshot`, `browser_find`, `browser_get_selector`, `browser_cookies`, `browser_storage`, `browser_downloads`, `browser_pdf`, `browser_console` |
| नेटवर्क और Mock | `browser_network_requests`, `browser_network_detail`, `browser_har`, `browser_mock_requests`, `browser_list_mocks`, `browser_clear_mocks` |
| डायग्नोस्टिक्स और टैब | `browser_performance`, `browser_resize`, `browser_tabs`, `browser_window`, `browser_tasks`, `browser_extensions`, `browser_evidence` |

साझा व्यवहार: ज़्यादातर टूल अपने नतीजे के साथ एक स्नैपशॉट लौटाते हैं (`snapshot: false` उसे छोड़ देता है), `browser_resize` और `browser_downloads` के अलावा हर टूल `tabId` स्वीकार करता है, एक कॉल 180 सेकंड बाद टाइम-आउट हो जाती है, मंज़ूरी 120 सेकंड तक प्रतीक्षा करती है, और नेटवर्क विवरण डिफ़ॉल्ट रूप से रीडैक्ट रहते हैं।

## सुरक्षा

- एजेंट सेवा सिर्फ़ `127.0.0.1` पर सुनती है, हर लॉन्च पर यादृच्छिक टोकन इस्तेमाल करती है और गैर-स्थानीय ओरिजिन अस्वीकार करती है; पोर्ट और टोकन `~/.aabrowser/connection.json` में रहते हैं और साफ़-सुथरे बंद होने पर हटा दिए जाते हैं।
- पेज व्यू preload स्क्रिप्ट के बिना चलते हैं; स्नैपशॉट और एक्शन स्क्रिप्ट मुख्य प्रोसेस इंजेक्ट करता है। नेविगेशन सिर्फ़ `http:` / `https:` की अनुमति देता है — `file:`, `data:`, `devtools:` जैसे प्रोटोकॉल अस्वीकार होते हैं।
- संवेदनशील इनपुट फ़ील्ड उपयोगकर्ता को खुद भरने होते हैं: एजेंट द्वारा दिया गया टेक्स्ट कभी लिखा, पढ़ा या लौटाया नहीं जाता। "जोखिम भरे कामों की पुष्टि" चालू होने पर फ़ॉर्म सबमिट, टाइप करने के बाद Enter, और बिना-रीडैक्शन नेटवर्क एक्सेस ब्राउज़र में मंज़ूरी का इंतज़ार करते हैं (120 सेकंड, फिर अस्वीकृत माना जाता है)।
- नेटवर्क विवरण और HAR एक्सपोर्ट डिफ़ॉल्ट रूप से ऑथेंटिकेशन हेडर और क्रेडेंशियल जैसे पैरामीटर रीडैक्ट करते हैं।
- **साइट अनुमति-सूची**: सिर्फ़ नेविगेशन पर लागू होती है; खाली छोड़ने पर यह बंद रहती है, और खाली होने पर भी `file:`, `data:`, `devtools:` तथा अन्य गैर-वेब प्रोटोकॉल ब्लॉक रहते हैं।
- **एजेंट कनेक्ट करने पर सिर्फ़ एक एंट्री बदलती है**: मौजूदा क्लाइंट कॉन्फ़िग पहले बैकअप होती हैं, सिर्फ़ `aa-browser` एंट्री बदली जाती है, कोई token या पासवर्ड कभी नहीं लिखा जाता, और इंस्टॉलर डाउनलोड में रिलीज़ का SHA-256 digest और फ़ाइल हेडर जाँचे जाते हैं।
- अलग-थलग टैब अलग सेशन पार्टिशन इस्तेमाल करते हैं: कोई साझा कुकी या लॉगिन नहीं, बंद होने पर साफ़, और ग्लोबल इतिहास, हाल में बंद सूची तथा सेशन रीस्टोर से बाहर।
- **सीमा**: एजेंट पेज सामग्री और ट्रैफ़िक देख सकता है, जिसमें कुकी, स्टोरेज, हेडर और रिस्पॉन्स बॉडी शामिल हैं। ये नियंत्रण राहत के उपाय हैं, सामान्य DLP नहीं — किसी अविश्वसनीय एजेंट को अति-संवेदनशील साइटों पर न लगाएँ।

कमज़ोरियों की सूचना [SECURITY.md](../../../SECURITY.md) की निजी रिपोर्टिंग से दें, कभी सार्वजनिक issue में नहीं।

## प्लेटफ़ॉर्म और सीमाएँ

| प्लेटफ़ॉर्म | आधिकारिक बिल्ड | नोट्स |
| --- | --- | --- |
| Windows 11 x64 | NSIS इंस्टॉलर | सक्रिय रूप से मेंटेन, CI और स्थानीय रिग्रेशन से कवर |
| Windows 10 x64 | वही इंस्टॉलर | Windows 11 बिल्ड साझा करता है; असली डिवाइस पर अपग्रेड स्वीकृति अभी बाकी है |
| Linux x86_64 (Ubuntu डेस्कटॉप) | AppImage | सिस्टम Node.js 22.12+ चाहिए; अन्य वितरणों के लिए असली डिवाइस पर सत्यापन ज़रूरी |
| Windows ARM64 / macOS / Android / iOS | कोई नहीं | इंस्टॉलर साफ़ मना कर देता है, इंस्टॉल होने का दिखावा नहीं करता |

ज्ञात सीमाएँ:

- Windows पर **कोड साइनिंग नहीं**: SmartScreen चेतावनी देता है और "अधिक जानकारी → फिर भी चलाएँ" माँगता है।
- **Chrome का विकल्प नहीं**: कोई बुकमार्क, एक्सटेंशन या अकाउंट/मल्टी-डिवाइस सिंक नहीं। दायरा है "ब्राउज़र कोर + एजेंट एक्सेस"।
- **Linux में MCP एक्सेस के लिए सिस्टम Node.js 22.12+ ज़रूरी**; Windows पर सिस्टम Node न मिलने पर बंडल किया गया रनटाइम इस्तेमाल होता है।
- **सेशन रीस्टोर सीमित है**: सिर्फ़ सामान्य वेब टैब, अधिकतम 20 एंट्री, कभी भी अलग-थलग टैब, आंतरिक पेज या गैर-HTTP(S) URL नहीं।
- **प्रति यूज़र-डेटा डायरेक्टरी एक ही इंस्टेंस**; डेव बिल्ड अपनी अलग डायरेक्टरी इस्तेमाल करता है, इसलिए दोनों साथ चल सकते हैं।
- **इंस्टॉल और अपडेट GitHub Releases पर निर्भर हैं**; AppImage का सेल्फ़-अपडेट लिखने योग्य डायरेक्टरी माँगता है।

## दस्तावेज़

विस्तृत दस्तावेज़ फ़िलहाल चीनी में है:

| दस्तावेज़ | सामग्री |
| --- | --- |
| [docs/CONNECT.md](../../../docs/CONNECT.md) | प्लेटफ़ॉर्म और क्लाइंट मैट्रिक्स, इंस्टॉलर फ़्लैग, मैन्युअल कदम, समस्या-निवारण |
| [docs/PLATFORMS.md](../../../docs/PLATFORMS.md) | रिलीज़ मैट्रिक्स, Linux निर्भरताएँ, अनइंस्टॉल और डेटा रिकवरी |
| [docs/AUTO_UPDATE.md](../../../docs/AUTO_UPDATE.md) | अपडेट जाँच, डाउनलोड, इंस्टॉल के लिए रीस्टार्ट, SHA-512 और रोलबैक |
| [docs/MARKETPLACE.md](../../../docs/MARKETPLACE.md) | DeepSeek Harness प्लगइन का इंस्टॉल और सत्यापन |
| [docs/MAINTENANCE.md](../../../docs/MAINTENANCE.md) | रिलीज़ प्रमाण, रिग्रेशन रिकॉर्ड और मेंटेनेंस सीमाएँ |
| [रिलीज़ नोट्स](../../../docs/releases/release-notes.md) / [CHANGELOG](../../../CHANGELOG.md) | प्रति वर्शन बदलावों का इतिहास |

## योगदान और लाइसेंस

बग रिपोर्ट, फ़ीचर चर्चा, दस्तावेज़ सुधार और PR का स्वागत है — पहले [CONTRIBUTING.md](../../../CONTRIBUTING.md) पढ़ें। MCP टूल जोड़ते समय `src/main/tools.ts`, `cli/mcp.mjs`, इस README की टूल तालिका और `src/shared/tool-defs.mjs` को साथ-साथ अपडेट करें; `npm run check` जाँचता है कि पहले तीन तालमेल में रहें।

MIT licensed — देखें [LICENSE](../../../LICENSE) © Aa Browser contributors.

यह अनुवाद चीनी मूल से पीछे रह सकता है। इस README के अनुवाद [README.md](../../../README.md) (简体中文) और `docs/i18n/readmes/README.<language>.md` फ़ाइलों में मेंटेन किए जाते हैं; पूरी सूची `../readme-languages.json` में है।
