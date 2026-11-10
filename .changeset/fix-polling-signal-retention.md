---
"chat-adapter-wechat": patch
---

修复长期 ACP polling 的内存累积：显式转发父 signal 的取消，并在请求结束时移除监听，避免反复组合 AbortSignal.any 导致 Node 清理登记记录持续增长。保留请求 timeout 和取消原因。
