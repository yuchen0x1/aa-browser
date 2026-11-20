# 未解决问题

| 优先级 | 事项 | 状态与下一步 |
| --- | --- | --- |
| P2 | CodeQL [#11](https://github.com/yuchen0x1/aa-browser/security/code-scanning/11) / [#12](https://github.com/yuchen0x1/aa-browser/security/code-scanning/12) | 基线仍开放；固定数据路径已加固，候选扫描待核对。显式求值本身是页面世界工具能力，不能把它与数据字面量混为一谈。 |
| P2 | 地址栏编辑可能改变现有 URL | 静态审阅发现紧凑显示会省略部分 URL；用受控 HTTP 页面验证编辑和回车往返后再决定修复。 |
| P2 | 快照分页可能传输未使用的元素元数据 | 静态候选；记录大页面基线并验证 ref、页游标和文本一致性。Playwright（Apache-2.0）是断言设计参考，不引入其代码或依赖。 |
| P3 | 连续导航的历史写盘负担 | 尚未量化；对照同为桌面浏览器的 Min（Apache-2.0）的产品取舍，不复制实现，不在本轮扩大架构改动。 |

巡检时 GitHub 无开放 Issue 或 PR。上表的静态候选不记为已复现缺陷。
