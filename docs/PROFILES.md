# Profile 使用指南

Profile 是一组持久化的浏览器身份。工作、个人和测试账号应分别放在不同 Profile；普通标签只在同一个 Profile 内共享登录态。

## 创建与使用

1. 打开「设置 → 配置文件」，填写名称、描述、图标和颜色后创建。
2. 从浏览器工具栏选择该 Profile，打开网站并手动登录。
3. 在 MCP 中调用 `browser_profiles action=list` 获取真实 ID，然后使用 `action=bind` 绑定当前客户端，或在每次工具调用里传 `profileId`。
4. 在工作流创建时选择 Profile。运行中的工作流持有独占租约，冲突的 Agent 操作返回 `PROFILE_BUSY`；暂停后等待在途步骤结束才能安全释放资源。

```json
{"name":"browser_profiles","arguments":{"action":"create","name":"工作账号","description":"日常网站巡检","color":"#36b5a0","icon":"briefcase"}}
```

```json
{"name":"browser_profiles","arguments":{"action":"bind","profileId":"从创建或列表结果返回的ID"}}
```

绑定只影响当前 MCP 客户端。单次调用上的 `profileId` 优先于客户端绑定，不会替其他客户端切换身份。不要把配置文件 ID 当作秘密或独立操作系统的访问凭据；同一台机器上被允许管理 Profile 的人仍能查看其元数据。

## 隔离与兼容

| 数据 | 默认身份 `default` | 新建身份 |
| --- | --- | --- |
| Chromium Session | 原有 `persist:aa-main` | `persist:aa-profile-<id>` |
| Cookie、LocalStorage、IndexedDB、缓存 | 保留旧数据 | 独立 Session 数据 |
| SessionStorage | 各标签的 Chromium 页面存储 | 同样遵循 Chromium 页面生命周期；不保证重启恢复标签内存状态 |
| 历史、下载、截图、HAR、基线 | 保留旧目录与环境变量 | `.aabrowser/profiles/<id>/` 下的独立目录 |
| 扩展、网站权限、代理认证 | 归属默认 Session | 归属指定 Profile，权限授权不跨 Session |

旧客户端不传参数时仍有默认环境可用。默认项可以改为其他 Profile；原始 `default` 继续保留，不能删除。需要旧行为时明确传 `profileId:"default"`。

`browser_tabs action=new isolated:true` 仍创建一次性隔离分区，关闭清理、不恢复、不加载该 Profile 扩展。它适合临时实验；需要跨重启保存账号应创建持久化 Profile。

## 生命周期

`start` 初始化指定 Session、网络配置与扩展；`stop` 关闭该 Profile 的页面、取消其下载、卸载运行中的扩展、刷新存储并关闭网络连接。停止状态不表示已销毁 Chromium Session，也不保证终止该 Session 的所有后台 Service Worker。完整进程资源释放需要退出应用；仅关闭页面不会释放全部数据库句柄。

删除会先确认、停止 Profile、清理其网站数据，再登记安全目录清理。Windows 可能持有数据库文件锁，待删除目录会在下次启动且 Session 初始化前清理。删除不会清空其他 Profile。工作流或其他浏览器操作正在使用该 Profile 时拒绝关闭或删除；停止、删除与备份期间拒绝新的自动化操作。

## 加密备份、恢复与复制

在配置文件界面填写至少 12 个字符的备份密码，选择导出或导入；文件对话框确定路径，备份密码不进入日志。备份使用 scrypt 派生密钥、AES-256-GCM 认证加密；错误密码或损坏文件会拒绝导入。

完整备份要求目标是离线 Profile：**该 Session 在当前进程中从未初始化**。先关闭目标 Profile 的全部标签，再退出并重启浏览器，在再次启动目标 Profile 之前导出或复制。仅点击“关闭”后立即导出仍可能返回 `PROFILE_OFFLINE_REQUIRED`，因为 Chromium 保留数据库句柄。若启动恢复了该身份的标签，需要先关闭这些标签并重新退出。

导入总是生成新 ID 和新目录，避免覆盖现有身份。复制复用同样的离线归档流程。限制为最多 128 MiB 数据、10000 个文件，拒绝符号链接、目录穿越和冲突文件名。外部解压扩展的登记路径可能包含原机器路径；不会自动打包任意外部扩展源码目录。

旧版默认身份使用共享应用路径，**不支持直接归档或复制**。完全退出应用后，备份 Electron 用户数据目录和 `.aabrowser` 两部分；恢复前保留现有目录副本。Chromium 的部分凭据由操作系统保护，拷贝到另一台机器、另一个系统账号或另一种系统后可能需要重新登录。

## 排查

| 提示 | 处理 |
| --- | --- |
| `PROFILE_BUSY` | 等待或暂停占用该身份的工作流，确认在途调用结束 |
| `PROFILE_OFFLINE_REQUIRED` | 关闭该身份页面，退出并重启，在启动它之前导出 |
| `PROFILE_LEGACY_BACKUP` | 完全退出后整体备份旧版默认身份的数据目录 |
| `PROFILE_REGISTRY_CORRUPT` | 保留原 `profiles.json`，从已验证备份恢复；不要手工清空浏览器数据库 |
| 导入成功但网站退出登录 | 检查系统账号/机器变化和网站令牌过期，重新手动登录 |

实现见 `src/main/profiles.ts`、`tabs.ts`、`session-store.ts`、`history.ts`、`downloads.ts` 和 `extensions.ts`。
