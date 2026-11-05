---
name: aa-browser
description: Use the locally installed Aa Browser connector for browser automation.
---

# Aa Browser

Use the `browser_*` tools from this connector only when the user asks to operate Aa Browser. First call `browser_tabs` to verify the connection. Do not substitute WorkBuddy built-in browser tools when validating this connector. For passwords, API keys, tokens, and other sensitive fields, never send the value through `browser_type`; let the user enter it directly in Aa Browser and follow its approval UI.
