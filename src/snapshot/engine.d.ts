/**
 * engine.js 的类型声明：注入引擎是纯页面脚本（自包含、无 import），
 * 以 .js 存放避免 TS 严格检查干扰；主进程只需要它的 toString()。
 */
export function __aaSnapshot(): unknown
