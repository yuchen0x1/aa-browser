/**
 * MCP 工具定义的唯一来源（single source of truth）。
 * 主进程 src/main/tools.ts 与 stdio 桥 cli/mcp.mjs 都从这里读取
 * name / title / description / inputSchema / annotations；handler 只存在于主进程。
 * 本文件为无依赖的纯 ESM，便于桥直接 import 并被 rolldown 内联。
 * 修改工具 schema 时只改这里，三方一致性由 npm run check 守护。
 */
export const TOOL_DEFS = [
  {
    name: 'browser_navigate',
    title: '导航',
    description:
      'Navigate the browser to a URL in the active tab (or a new tab). Plain text that is not a URL is treated as a search query. Returns a full page snapshot after loading, so you can act immediately (pass snapshot:false to skip it if you only need browser_extract / browser_wait). For SPAs (Discourse, React apps), pass waitFor to wait until the real content is rendered; a timeout returns isError with the partial page snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL or search query' },
        newTab: { type: 'boolean', description: 'Open in a new tab instead of the active one (default false)' },
        snapshot: { type: 'boolean', description: 'Include a full snapshot in the result (default true)' },
        waitFor: {
          type: 'object',
          description: 'Wait after load until one condition is met (default timeout 10000ms, max 30000ms)',
          properties: {
            selector: { type: 'string', description: 'Wait until this CSS selector matches a visible element (preferred for SPAs)' },
            text: { type: 'string', description: 'Wait until this text appears on the page' },
            urlContains: { type: 'string', description: 'Wait until the page URL contains this string' },
            timeoutMs: { type: 'number', description: 'Wait timeout in ms (default 10000, max 30000)' }
          }
        },
        tabId: { type: 'string', description: 'Operate on a specific tab id (from browser_tabs list)' }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_reload',
    title: '刷新',
    description: 'Reload the active tab or the tab identified by tabId. Set hard:true to bypass the cache. Returns the page URL, title, and an incremental snapshot by default.',
    inputSchema: {
      type: 'object',
      properties: {
        hard: { type: 'boolean', description: 'Bypass the HTTP cache (default false)' },
        snapshot: { type: 'boolean', description: 'Return a snapshot after reload (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_snapshot',
    title: '页面快照',
    description:
      'Capture a structured accessibility snapshot of the active tab as a YAML-style tree. Interactive elements carry [ref=eN] ids; pass a ref to browser_click / browser_type / browser_select_option to act on them. Snapshots are incremental: unchanged page returns a one-line reply, small changes return only the changed region, and refs stay stable across snapshots. Pass full:true to force a complete tree (automatic after navigation or large changes). For very long pages, pass maxNodes to page through the tree: the response reports totalLines and nextCursor; pass cursor on the next call. Paging still assigns refs for the whole tree, so refs from any page remain usable.',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Force a full snapshot instead of incremental (default false)' },
        maxNodes: { type: 'number', description: 'Page size: max lines to return per call (1–2000). Omit for the normal full/incremental snapshot.' },
        cursor: { type: 'number', description: 'Line offset for a paged snapshot, from the previous response nextCursor (default 0)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_click',
    title: '点击',
    description:
      'Click an element by its snapshot ref (e.g. "e12"). Supports left click, right click (context menu), double click. An incremental snapshot is returned afterwards so you can see the result and continue.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. "e12"' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default "left")' },
        doubleClick: { type: 'boolean', description: 'Perform double click (default false)' },
        snapshot: { type: 'boolean', description: 'Return an incremental snapshot after the action (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref']
    }
  },
  {
    name: 'browser_drag',
    title: '拖拽',
    description:
      'Drag an element by ref to another element (toRef) or by a relative pixel offset (dx, dy). Useful for sliders, drag-and-drop sortable lists, and canvas boards.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Source element ref to drag from' },
        toRef: { type: 'string', description: 'Target element ref to drop onto' },
        dx: { type: 'number', description: 'Relative horizontal offset in pixels (e.g. 150)' },
        dy: { type: 'number', description: 'Relative vertical offset in pixels (e.g. -50)' },
        snapshot: { type: 'boolean', description: 'Return an incremental snapshot after the action (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref']
    }
  },
  {
    name: 'browser_type',
    title: '输入文本',
    description:
      'Type text into a textbox/contenteditable by ref. Use submit:true to press Enter after typing (e.g. submit a search box). Use clear:true to empty the field first.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref of the textbox' },
        text: { type: 'string', description: 'Text to type' },
        submit: { type: 'boolean', description: 'Press Enter after typing (default false)' },
        clear: { type: 'boolean', description: 'Clear the field before typing (default false)' },
        snapshot: { type: 'boolean', description: 'Return an incremental snapshot after the action (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref', 'text']
    }
  },
  {
    name: 'browser_select_option',
    title: '下拉选择',
    description: 'Select an option in a <select> dropdown by ref, matching by value or visible label.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref of the combobox' },
        value: { type: 'string', description: 'Option value to select' },
        label: { type: 'string', description: 'Option visible label to select' },
        snapshot: { type: 'boolean', description: 'Return an incremental snapshot after the action (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref']
    }
  },
  {
    name: 'browser_scroll',
    title: '滚动页面',
    description:
      'Scroll the page (window first, then the largest scrollable area in the requested direction). Returns the real before/after position, didScroll, atLimit and visibilityState: a scroll that did not move the page reports didScroll:false with a reason instead of a success message. Useful before re-snapshotting content outside the viewport.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Pixels to scroll (default 700, max 3000)' },
        snapshot: { type: 'boolean', description: 'Return an incremental snapshot after the action (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['direction']
    }
  },
  {
    name: 'browser_extract',
    title: '提取文本',
    description: 'Extract readable text from the page (or a specific element by ref) as plain text. Better than snapshot when you only need content, not interactive elements.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Extract text of this element only (default: whole page)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_page_state',
    title: '页面状态',
    description:
      'Read a compact page-state summary in one call: URL, title, readyState, visibilityState/hasFocus, scroll position/height/viewport (and whether the page is scrollable), visible dialogs plus intercepted alert/confirm/prompt records, Cloudflare challenge and rate-limit hints, and the browser/tab identity. Read-only. Use it before long tasks or whenever navigation or scrolling seems to have no effect.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_cloudflare',
    title: 'Cloudflare 验证助手',
    description:
      'Inspect a Cloudflare challenge that is hidden inside a cross-origin iframe, wait until the challenge settles, or (with confirm:true) send one real pointer click to a visible checkbox. This is a human-in-the-loop helper: it does not extract tokens, alter cookies, or solve sliders/images; complete those challenges yourself in the page.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inspect', 'click', 'wait'], description: 'Challenge operation (default inspect)' },
        frameId: { type: 'string', description: '(click) frame id returned by inspect; omit to choose the first visible checkbox' },
        candidateIndex: { type: 'number', description: '(click) control index returned by inspect' },
        confirm: { type: 'boolean', description: '(click) must be true to send the real pointer event' },
        timeoutMs: { type: 'number', description: '(wait) maximum wait in milliseconds, default 30000, max 120000' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_wait',
    title: '等待',
    description:
      'Wait for one of: text to appear (`text`), text to disappear (`textGone`), a selector to appear (`selector`) or disappear (`selectorGone`), the URL to contain a string (`urlContains`), or a fixed delay (`time`, ms). Multiple conditions wait for whichever happens first. Polls every 250ms. Prefer selector/urlContains on SPAs where text is reused; use text conditions for plain pages.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Wait until this text appears on the page' },
        textGone: { type: 'string', description: 'Wait until this text disappears from the page' },
        selector: { type: 'string', description: 'Wait until this CSS selector matches a visible element' },
        selectorGone: { type: 'string', description: 'Wait until this CSS selector matches nothing' },
        urlContains: { type: 'string', description: 'Wait until the page URL contains this string' },
        time: { type: 'number', description: 'Wait a fixed number of milliseconds (max 30000)' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 10000, max 30000)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_press_key',
    title: '按键',
    description: 'Press a key on the focused element, optionally with Ctrl/Alt/Shift/Meta modifiers. Supports Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, PageUp/PageDown, Home/End, F1-F12, a single character, or common combinations such as Ctrl+C and Ctrl+Shift+R.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name or combination, e.g. "Enter", "Escape", "Ctrl+C", "Ctrl+Shift+R"' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'meta'] }, description: 'Optional modifier keys; equivalent to including them in key with +.' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['key']
    }
  },
  {
    name: 'browser_screenshot',
    title: '截图',
    description:
      'Take a PNG screenshot of the active tab, or of a specific element (pass ref — the view is scrolled to it and the image is cropped to its bounding box). Pass fullPage:true to capture the whole document (not just the viewport) — use that when reviewing long pages or comparing layout. Returns the image inline (for vision-capable models) and saves it under ~/.aabrowser/screenshots/.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref: screenshot only this element (default: whole viewport)' },
        fullPage: { type: 'boolean', description: 'Capture the whole document instead of the viewport (max 8000px tall)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_hover',
    title: '悬停',
    description:
      'Hover the mouse over an element by ref (triggers hover menus, tooltips, dropdown reveals). Uses the real input path so hover-dependent UI behaves as for a human.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref']
    }
  },
  {
    name: 'browser_navigate_back',
    title: '后退',
    description: 'Go back one page in the active tab history. Returns a fresh incremental snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot: { type: 'boolean', description: 'Return a snapshot after navigation (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_navigate_forward',
    title: '前进',
    description: 'Go forward one page in the active tab history. Returns a fresh incremental snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot: { type: 'boolean', description: 'Return a snapshot after navigation (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_resize',
    title: '调整视口',
    description:
      'Resize the browser window content area (200–5000). Useful for responsive-design checks; then take browser_snapshot or browser_screenshot to see the adapted layout.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Content width in px (200–5000)' },
        height: { type: 'number', description: 'Content height in px (200–5000)' }
      },
      required: ['width', 'height']
    }
  },
  {
    name: 'browser_get_selector',
    title: '导出选择器',
    description:
      'Generate a CSS selector for a snapshot ref element (verified against the DOM). Use it to reuse the element in scripts, tests, or querySelector-based follow-up work.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref']
    }
  },
  {
    name: 'browser_find',
    title: '页面查找',
    description:
      'Find text on the page (native Ctrl+F behavior): highlights every match, scrolls to the first one and reports the match count. Keep the highlight for the user; call with browser_scroll to move on.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to find' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['text']
    }
  },
  {
    name: 'browser_cookies',
    title: 'Cookie 管理',
    description:
      'Get / set / clear cookies of the browser session (covers all sites the session has visited). Essential for login-state testing. set requires url + name + value.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'clear'], description: 'Operation' },
        url: { type: 'string', description: '(get/set/clear) Cookie belongs to this URL; with clear, only cookies for this site are removed' },
        name: { type: 'string', description: '(get: filter by name; set: cookie name; clear: only clear this name)' },
        value: { type: 'string', description: '(set) Cookie value' },
        domain: { type: 'string', description: '(set/clear filter) Cookie domain' },
        secure: { type: 'boolean', description: '(set) Secure flag (default: true for https URLs)' },
        httpOnly: { type: 'boolean', description: '(set) HttpOnly flag' },
        expiresSeconds: { type: 'number', description: '(set) Expires in N seconds from now (omit = session cookie)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['action']
    }
  },
  {
    name: 'browser_storage',
    title: '页面存储',
    description: 'Read / write / remove / clear localStorage or sessionStorage of the active page origin.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'remove', 'clear'], description: 'Operation (get without key = list all)' },
        kind: { type: 'string', enum: ['local', 'session'], description: 'localStorage (default) or sessionStorage' },
        key: { type: 'string', description: 'Storage key (get without key = list all entries)' },
        value: { type: 'string', description: '(set) Value to store' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['action']
    }
  },
  {
    name: 'browser_downloads',
    title: '下载列表',
    description:
      'List files captured by the browser (downloads are saved silently under ~/.aabrowser/downloads/, no save dialog). action=list (default) shows filename, source URL, size and progress/state. action=cancel stops an in-progress download; action=retry re-downloads a finished one into a new -r file (URL is re-validated against the site allowlist).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'cancel', 'retry'], description: 'Download operation (default list)' },
        id: { type: 'string', description: '(cancel/retry) download id from action=list' },
        limit: { type: 'number', description: '(list) Max entries (default 20, newest last)' }
      }
    }
  },
  {
    name: 'browser_pdf',
    title: '存为 PDF',
    description: 'Render the active page to a PDF (A4, print background on) and save it. Returns the file path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output file path inside the browser export dirs (~/.aabrowser/downloads, har, screenshots or AA_BROWSER_EXPORT_DIR; default ~/.aabrowser/downloads/aa-page-<ts>.pdf). Symlinks and paths outside those dirs are rejected.' },
        landscape: { type: 'boolean', description: 'Landscape orientation (default false)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_upload_file',
    title: '上传文件',
    description:
      'Upload local file(s) into a <input type=file> element by ref. Accepts absolute local paths; total size capped at 20MB. Fire-and-forget is enough — the change event fires for the page.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref of the file input' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute local file path(s)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref', 'paths']
    }
  },
  {
    name: 'browser_console',
    title: '控制台日志',
    description: 'Read recent console messages of the active tab (useful for debugging pages).',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['all', 'info', 'warning', 'error'], description: 'Filter level (default all)' },
        limit: { type: 'number', description: 'Max entries (default 50)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_performance',
    title: '页面性能摘要',
    description:
      'Summarize performance metrics of the active tab: navigation timing (TTFB / DOMContentLoaded / load), First Contentful Paint, resource count and transfer size, slowest resources, JS heap usage and DOM size. Read-only diagnostics for slow pages; no DevTools needed.',
    inputSchema: {
      type: 'object',
      properties: {
        slowest: { type: 'number', description: 'How many slowest resources to list (default 5, max 20)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_network_requests',
    title: '网络请求列表（抓包）',
    description:
      'List captured network requests of the active tab (HTTP-level packet capture): id, method, status, type, size, duration, URL. Capture starts automatically on first use. Use browser_network_detail with a request id to inspect headers and response body.',
    inputSchema: {
      type: 'object',
      properties: {
        urlContains: { type: 'string', description: 'Only requests whose URL contains this (case-insensitive)' },
        method: { type: 'string', description: 'Filter by HTTP method, e.g. GET/POST' },
        statusMin: { type: 'number', description: 'Minimum HTTP status (e.g. 400 for errors)' },
        statusMax: { type: 'number', description: 'Maximum HTTP status' },
        resourceType: { type: 'string', description: 'Filter by type: Document/Script/XHR/Fetch/Image/Stylesheet/…' },
        limit: { type: 'number', description: 'Max entries (default 50, newest last)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_network_detail',
    title: '网络请求详情',
    description:
      'Inspect one captured network request: headers, status, size, duration, and (with body:true) the response body text. Authentication headers, credential-like URL parameters, and recognized sensitive fields in JSON/text bodies are redacted by default; response bodies are capped before crossing the MCP boundary. Pass includeSensitive:true only when needed.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Request id from browser_network_requests, e.g. "1234.5"' },
        body: { type: 'boolean', description: 'Include the response body (default false)' },
        includeSensitive: { type: 'boolean', description: 'Include authentication headers and credential-like URL parameters (default false; use only when needed)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['requestId']
    }
  },
  {
    name: 'browser_har',
    title: '导出 HAR',
    description:
      'Export captured network traffic as HAR 1.2 (no response bodies). Authentication headers and credential-like URL parameters are redacted by default; pass includeSensitive:true only when needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output file path inside the browser export dirs (~/.aabrowser/downloads, har, screenshots or AA_BROWSER_EXPORT_DIR; default ~/.aabrowser/har/aa-<timestamp>.har). Symlinks and paths outside those dirs are rejected.' },
        includeSensitive: { type: 'boolean', description: 'Include authentication headers and credential-like URL parameters (default false; handle the exported file as sensitive)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_mock_requests',
    title: '请求拦截 Mock',
    description:
      'Intercept and mock HTTP requests of the active tab. Add or replace a rule that matches a URL substring (and optional method); matched requests are answered with a fake status/headers/body instead of reaching the network. Use to simulate API responses, error states, or stub third-party calls during testing. Pass action:"continue" to just observe (log) a matching request without answering it. Returns the rule id and current rules.',
    inputSchema: {
      type: 'object',
      properties: {
        urlContains: { type: 'string', description: 'Substring of request URL to match (case-insensitive), e.g. "/api/v1/quote"' },
        method: { type: 'string', description: 'Only mock this HTTP method (e.g. GET/POST). Omit to match any.' },
        status: { type: 'number', description: 'Fake response status code (default 200)' },
        headers: { type: 'object', description: 'Fake response headers (optional)' },
        body: { type: 'string', description: 'Fake response body text (default empty)' },
        action: { type: 'string', enum: ['respond', 'continue'], description: 'respond=answer with mock (default); continue=just pass through' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['urlContains']
    }
  },
  {
    name: 'browser_list_mocks',
    title: '列出 Mock 规则',
    description: 'List all active request-mock rules of the active tab (id, matcher, status, hits).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_clear_mocks',
    title: '清空 Mock 规则',
    description:
      'Remove all (or one, by rule id) request-mock rules of the active tab and stop intercepting. Pass id to remove a single rule. Returns how many were removed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Rule id to remove (omit to clear all)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_fill_form',
    title: '批量填写表单',
    description:
      'Fill multiple form fields in one call instead of one browser_type per field. Each item takes a ref plus either `value` (text input / select option value), `label` (select by visible label), or `checked` (checkbox / radio). Fields are filled in order and the resulting snapshot is returned once at the end, which makes multi-field forms far cheaper than repeated single-field calls.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description: 'Fields to fill, in order',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'Element ref' },
              value: { type: 'string', description: 'Text to type, or option value for a <select>' },
              label: { type: 'string', description: 'Option visible label for a <select>' },
              checked: { type: 'boolean', description: 'Desired checked state for checkbox/radio' },
              submit: { type: 'boolean', description: 'Press Enter after typing this field (default false)' }
            },
            required: ['ref']
          }
        },
        snapshot: { type: 'boolean', description: 'Return an incremental snapshot after all fields (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['fields']
    }
  },
  {
    name: 'browser_evaluate',
    title: '执行 JavaScript',
    description:
      'Evaluate a JavaScript expression in the page (or on a specific element by ref) and return the result as JSON. Runs in the page main world. Use for values not exposed by snapshot/extract, e.g. reading a computed style or a JS variable. The expression must be a single expression or IIFE.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate, e.g. "document.title" or "(() => {...})()"' },
        ref: { type: 'string', description: 'Element ref to bind as the `element` variable (optional)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['expression']
    }
  },
  {
    name: 'browser_dialogs',
    title: '页面对话框记录',
    description:
      'Read (and optionally clear) dialogs the page tried to open — alert / confirm / prompt. Dialogs are intercepted instead of blocking: by default confirm returns false and prompt returns null. Use browser_dialog_respond first to choose what confirm/prompt return, then click the control that triggers them. Use this tool to detect "are you sure?" style interruptions without stalling the automation.',
    inputSchema: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'Clear the recorded list after reading (default false)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_dialog_respond',
    title: '对话框应答策略',
    description:
      'Decide what the next (or every following) window.confirm / window.prompt returns, so flows that need confirmation or text input can be tested. Set confirm:true to accept, confirm:false to cancel, prompt:"text" to answer a prompt (prompt with no value returns null). Default is once:true — the policy is consumed by the next dialog; pass once:false to keep it. Pass reset:true to clear the policy.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'What window.confirm returns (true = accept, false = cancel)' },
        prompt: { type: 'string', description: 'What window.prompt returns as the entered text' },
        once: { type: 'boolean', description: 'Consume the policy after the next dialog (default true)' },
        reset: { type: 'boolean', description: 'Clear any policy and restore the default (confirm→false, prompt→null)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_assert',
    title: '断言校验',
    description:
      'Verify that what you just did actually worked. Pass one or more checks; each is reported as passed or failed with expected vs actual, and the tool returns isError when any check fails — that is how you distinguish "the click happened" from "the feature works". Supported kinds: url, title, text, selector, count, value, checked, attribute, console, network. match defaults to contains for text-like kinds, equals for count/console, and exists for selector. Use this after every meaningful step of a website test.',
    inputSchema: {
      type: 'object',
      properties: {
        checks: {
          type: 'array',
          description: 'Assertions to verify, evaluated in order',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['url', 'title', 'text', 'selector', 'count', 'value', 'checked', 'attribute', 'console', 'network'],
                description: 'What to check'
              },
              target: { type: 'string', description: 'CSS selector or snapshot ref (e.g. e12) for selector/count/value/checked/attribute' },
              match: {
                type: 'string',
                enum: ['equals', 'contains', 'notContains', 'regex', 'gte', 'lte', 'exists', 'absent'],
                description: 'Comparison mode (default depends on kind)'
              },
              expected: { description: 'Expected value: string, number (count/console) or boolean (checked)' },
              message: { type: 'string', description: 'Human-readable label shown in the result' },
              attribute: { type: 'string', description: '(attribute) attribute name' },
              level: { type: 'string', enum: ['error', 'warning', 'all'], description: '(console) level filter, default error' },
              since: { type: 'number', description: '(console) only logs after this Unix ms timestamp' },
              urlContains: { type: 'string', description: '(network) request URL substring' },
              method: { type: 'string', description: '(network) HTTP method filter' },
              status: { type: 'number', description: '(network) exact status code required' },
              statusMin: { type: 'number', description: '(network) minimum status' },
              statusMax: { type: 'number', description: '(network) maximum status' }
            },
            required: ['kind']
          }
        },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['checks']
    }
  },
  {
    name: 'browser_frame',
    title: 'iframe 操作',
    description:
      'Operate inside any frame, including cross-origin iframes that browser_snapshot cannot see into (payment widgets, OAuth, embedded editors, third-party chat). action=list shows every frame with its id, URL and whether it is cross-origin. action=text reads that frame text, action=elements lists interactive elements with usable CSS selectors, action=evaluate runs an expression inside the frame, and action=click/type/select act on a CSS selector inside the frame. Always start with action=list.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'text', 'elements', 'evaluate', 'click', 'type', 'select'],
          description: 'Frame operation'
        },
        frameId: { type: 'string', description: 'Frame id from action=list, e.g. "f3"' },
        selector: { type: 'string', description: '(click/type/select) CSS selector inside that frame' },
        expression: { type: 'string', description: '(evaluate) JavaScript expression evaluated inside the frame' },
        text: { type: 'string', description: '(type) text to enter' },
        value: { type: 'string', description: '(select) option value' },
        label: { type: 'string', description: '(select) option visible label' },
        index: { type: 'number', description: '(click) which match to click, 0-based (default 0)' },
        maxChars: { type: 'number', description: '(text) max characters to return (default 4000)' },
        limit: { type: 'number', description: '(elements) max elements to list (default 80)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['action']
    }
  },
  {
    name: 'browser_tabs',
    title: '标签管理',
    description:
      'Manage this MCP client’s tabs: "list" shows only tabs owned by this client (the first operation may claim the current unowned tab); "new" opens an owned tab without switching the user’s visible tab; "select" changes this client’s default tab (pass bringToFront:true only when intentionally switching the shared visible browser); "close" closes an owned tab. Tabs share the browser session (cookies/logins) unless created with isolated:true, which uses a throwaway partition cleared on close.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'], description: 'Tab operation' },
        url: { type: 'string', description: '(action=new) URL to open' },
        isolated: { type: 'boolean', description: '(action=new) Use a throwaway session partition instead of the shared one (default: settings)' },
        tabId: { type: 'string', description: '(action=select/close) target tab id' },
        bringToFront: { type: 'boolean', description: '(action=select) Also restore/show the browser window and focus the page (default false: only switches the active tab)' }
      },
      required: ['action']
    }
  },
  {
    name: 'browser_window',
    title: '后台窗口与实时预览',
    description:
      'Control the real Electron window mode without changing the browser profile: visible (normal foreground), background (shown without taking focus), minimized, hidden, or background-visual (background operation with an independent live preview). action=mode gets or sets the mode; action=monitor starts/stops preview for one explicit tab; action=takeover locks AI input for human control; action=release hands control back to AI. The preview captures only the selected tab and keeps a bounded screenshot history.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['mode', 'monitor', 'takeover', 'release'], description: 'Window/monitor operation' },
        mode: { type: 'string', enum: ['visible', 'background', 'minimized', 'hidden', 'background-visual'], description: '(action=mode) real Electron window mode' },
        monitor: { type: 'boolean', description: '(action=mode) also start/stop the independent preview' },
        tabId: { type: 'string', description: '(action=monitor) tab to preview; defaults to the active tab' }
      },
      required: ['action']
    }
  },
  {
    name: 'browser_tasks',
    title: '后台任务中心',
    description:
      'Inspect tasks and recent execution logs scoped to the calling MCP client/session. action=list returns active calls and bounded history; action=get returns one durable task with its recorded steps and recovery policy; action=cancel stops one owned call; action=pause/resume only affects the calling client. Restarted processes never auto-replay interrupted work. The browser UI can pause all clients, and browser_window takeover locks the shared browser for human control with a live preview.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'cancel', 'pause', 'resume'], description: 'Task operation' },
        taskId: { type: 'string', description: '(action=get) durable task id returned by list or a tool result' },
        id: { type: 'number', description: '(action=cancel) MCP call id' },
        client: { type: 'number', description: '(action=cancel) optional client number; must match the calling MCP client' }
      },
      required: ['action']
    }
  },
  {
    name: 'browser_visual_diff',
    title: '视觉基线对比',
    description:
      'Visual regression loop for UI review. action=save stores the current page screenshot as a named baseline (under ~/.aabrowser/baselines/, override with AA_BROWSER_BASELINE_DIR); action=compare captures again and returns a pixel-level diff (changed pixels, percent, bounding box, mean/max channel difference) plus a red diff image path. compare returns isError when the change exceeds maxDiffPercent, so it can be used as a visual assertion. action=list shows baselines; action=delete removes one. Use fullPage:true for long pages.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'compare', 'list', 'delete'], description: 'Baseline operation' },
        name: { type: 'string', description: 'Baseline name: letters/digits/dot/underscore/hyphen, max 80 chars' },
        fullPage: { type: 'boolean', description: 'Capture the whole document instead of the viewport (default false)' },
        pixelThreshold: { type: 'number', description: 'Per-channel difference that counts as a changed pixel (0–255, default 16)' },
        maxDiffPercent: { type: 'number', description: 'Fail the comparison when changed pixels exceed this percent (default 0.5)' },
        writeDiff: { type: 'boolean', description: 'Write a red-highlighted diff PNG (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['action']
    }
  },
  {
    name: 'browser_contrast_audit',
    title: '对比度审计',
    description:
      'Audit WCAG text contrast on the current page. Reads computed foreground/background colors of visible text elements (compositing alpha over ancestors), computes contrast ratio and flags AA (4.5:1 / 3:1 large) or AAA (7:1 / 4.5:1 large) violations with a CSS selector and text snippet. Use this to find unreadable text before shipping. Returns isError when violations exist unless failOnViolation:false.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['AA', 'AAA'], description: 'WCAG conformance level (default AA)' },
        maxResults: { type: 'number', description: 'Max violations to report (1–200, default 50)' },
        failOnViolation: { type: 'boolean', description: 'Return isError when violations exist (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_viewport_matrix',
    title: '多视口矩阵',
    description:
      'Capture the same page at multiple viewport sizes and DPI scales in one call — use it for responsive-design review. Uses CDP device-metrics emulation, so it can render real 320/480/768px viewports and 2x high-DPI even though the BrowserWindow itself has a 960×640 minimum; the override is always cleared afterwards. Each entry reports actual PNG pixels and horizontal overflow. preset defaults to all; pass viewports to define exact sizes. Screenshots are saved under ~/.aabrowser/screenshots/.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: ['mobile', 'tablet', 'desktop', 'hi-dpi', 'all'], description: 'Viewport preset (default all)' },
        viewports: {
          type: 'array',
          description: 'Explicit viewport list; overrides preset. Max 12 entries.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Short label (letters/digits/_/-)' },
              width: { type: 'number', description: 'CSS width in px (200–5000)' },
              height: { type: 'number', description: 'CSS height in px (200–5000)' },
              deviceScaleFactor: { type: 'number', description: 'DPI scale 1–4 (default 1)' },
              mobile: { type: 'boolean', description: 'Emulate mobile viewport (default false)' }
            },
            required: ['width', 'height']
          }
        },
        includeImages: { type: 'boolean', description: 'Attach up to 4 screenshots as image blocks in the result (default false)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_extensions',
    title: '浏览器扩展',
    description:
      'Manage unpacked (Load unpacked) Chrome extensions. action=list shows loaded extensions (id, name, version, manifest version, local path); action=load loads an unpacked extension from an absolute directory path that contains manifest.json (persisted, reloaded on browser restart, injected into the shared session; isolated tabs do not get extensions); action=remove unloads one by path or extension id and removes it from the persisted list. Extensions take effect for new page loads — reload the tab after loading one.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'load', 'remove'], description: 'Extension operation (default list)' },
        path: { type: 'string', description: '(load) absolute directory containing manifest.json; (remove) alternative to id' },
        id: { type: 'string', description: '(remove) extension id from action=list' }
      }
    }
  },
  {
    name: 'browser_evidence',
    title: '证据文件管理',
    description:
      'Inspect and maintain generated evidence files (screenshots, viewport PNGs, HAR, PDF, visual baselines/diffs, context-menu shots). action=list shows registered files with sha256, size, TTL and age; action=sweep deletes expired or over-quota temporary evidence (baselines/downloads are preserved); action=hash computes a file sha256; action=forget removes a registry entry without deleting the file. Registry path can be overridden with AA_BROWSER_EVIDENCE_FILE.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'sweep', 'hash', 'forget'], description: 'Evidence operation (default list)' },
        file: { type: 'string', description: '(hash/forget) absolute file path' },
        limit: { type: 'number', description: '(list) max entries, default 50' }
      }
    }
  }
]


export const TOOL_ANNOTATIONS = Object.freeze({
  browser_navigate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_reload: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_snapshot: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_click: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_drag: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_type: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_select_option: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_scroll: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_extract: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_page_state: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_cloudflare: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_wait: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_press_key: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_screenshot: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_hover: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_navigate_back: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_navigate_forward: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_resize: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  browser_get_selector: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_find: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_cookies: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_storage: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_downloads: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  browser_pdf: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_upload_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_console: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_performance: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_network_requests: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_network_detail: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_har: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_mock_requests: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_list_mocks: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  browser_clear_mocks: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  browser_tabs: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_window: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  browser_tasks: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  browser_fill_form: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_dialogs: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_dialog_respond: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  browser_frame: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_assert: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_evaluate: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_visual_diff: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  browser_contrast_audit: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_viewport_matrix: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  browser_extensions: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  browser_evidence: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
})
