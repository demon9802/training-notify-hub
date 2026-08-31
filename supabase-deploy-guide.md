# 培训通知助手 — 云端定时发送 部署指引（方案 A）

## 目标
把「定时自动发送」从【本地 Node 8788】彻底迁移到【Supabase 云端函数 `send-due-scheduled`】，实现 **不依赖你电脑** 的定时发送，并用高频调用做免费版 7 天停机保活。

## 最终架构（三轨）
| 轨道 | 职责 |
|---|---|
| EdgeOne 静态前端 | UI / 运营操作 |
| Supabase `send-due-scheduled`（pg_cron 每 5 分钟触发） | **定时发送唯一生产链路** |
| 本地 Node 8788 | 仅手动立即发送 / 预览；`hybrid/cloud` 下跳过自动调度 |

## 前提（已具备 / 需你确认）
- Supabase 项目：`https://qyxxchifknfmvvyjvoue.supabase.co`（免费版）
- 表 `tn_kv`（项目/群/设置）与 `tn_sends`（去重锁）已存在；`tn_sends` 字段已与函数写入对齐核验
- 本地 `training-notification-server.js` 已加 `hybrid/cloud` 跳过调度守卫（语法校验通过）
- 代码产物：`supabase/functions/send-due-scheduled/index.ts`、`supabase/scheduled-setup.sql`

> ## ⚠️ 关键 Bug 修复（2026-08-31 实测发现，部署后必须重发）
> 原 `index.ts` 里项目查询写成了 `key: 'like.project.%'`，但 **PostgREST 的 `like` 通配符是 `*` 不是 `%`**：
> - `like.project.%`（裸 `%`）→ HTTP 500（error code 1101）
> - `like.project.%25`（编码后）→ 200 但返回 **0 行**（函数因此永远扫不到任何项目，**每 5 分钟 cron 实际一次都没发出过通知**）
> - 正确写法：`like.*project*`（已修复进 `index.ts`）
>
> 如果你之前已经按旧版本部署过函数，请**重新粘贴修复后的 `index.ts` 全文并再次 Deploy**，否则定时发送永远是空跑。
> 验证修复是否生效：`POST /functions/v1/send-due-scheduled`（不带 `?ping=1`）返回里 `scanned` 应等于你的项目数量（非 0）。

## 你需在 Supabase 控制台手动完成的 4 步

**① 部署 Edge Function**
- 路径：Supabase 控制台 → Edge Functions → New Function
- 名称：`send-due-scheduled`
- 内容：粘贴 `supabase/functions/send-due-scheduled/index.ts` 全文
- 点击 Deploy

**② 设置 Secrets（函数 → Secrets / Variables，可选）**
> Supabase Edge Function 运行时已自动注入 `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_DB_URL`，不设也能跑。显式设 Secret 是更强的覆盖，便于跨环境复用同一份代码。

- `SUPABASE_URL` = `https://qyxxchifknfmvvyjvoue.supabase.co`（**通常无需手动设**，自动注入就是它）
- `SUPABASE_SERVICE_ROLE_KEY` = Settings → API → `service_role`（**必设**或依赖自动注入；注意是 service_role，不是 anon；绝不下发前端）

**③ 建立 pg_cron 调度**
- 打开 SQL Editor，粘贴 `supabase/scheduled-setup.sql`
- 把其中 `<YOUR_SUPABASE_URL>` 替换为 `https://qyxxchifknfmvvyjvoue.supabase.co`
- 把 `<YOUR_SUPABASE_ANON_KEY>` 替换为 Settings → API → `anon public` key
- 点击 Run
- 预期：创建两个 job —— `send-due-scheduled`（每 5 分钟）、`keepalive-supabase`（每 12h，`?ping=1`）
- 若 `create extension pg_net` 失败：改用 Dashboard → Edge Functions → `send-due-scheduled` → Schedules，Cron 填 `*/5 * * * *`（无需 pg_net，同样保活）

**④ 验证函数可触达（保活冒烟）**
- 请求：`POST <SUPABASE_URL>/functions/v1/send-due-scheduled?ping=1`
- Header：`Authorization: Bearer <ANON_KEY>`、`Content-Type: application/json`
- 应返回：`{"ok":true,"ping":true,"ts":...}`

## 功能验证（⚠️ 必须用隔离测试群，禁止打生产企业微信群）
1. 在**隔离测试群**建一个通知受众，`notifyAt` 设为 `当前时间 + 2 分钟`，`targetGroups` 指向测试群，`autoSend=true`
2. 等一个 5 分钟周期（或手动 `POST /functions/v1/send-due-scheduled` 带 anon Header）后，确认测试群收到 news 卡片
3. 确认 `tn_sends` 出现该条 `status=sent`；`tn_kv` 里该 notification 的 `sentAudiences` 含该受众
4. 通过后再清理测试数据

## 完成后通知我 → 我重启本地 8788
- 当前运行的仍是旧 `server.js`（本地仍在自动发），作为云端上线前的**过渡发送方**
- 云端验证通过后，我会重启 8788 加载新代码（`hybrid` 下跳过本地调度）→ 云端成为**唯一**发送方
- 重启前请勿手动停掉旧进程，避免「两端都不发」空窗

## 回滚
- 停用调度：
  ```sql
  select cron.unschedule('send-due-scheduled');
  select cron.unschedule('keepalive-supabase');
  ```
- 恢复本地自动发：`.env` 改 `TN_DATA_BACKEND=local` 并重启 8788

## 免费版额度复核
- Edge Function 调用：每 5 分钟 1 次 ≈ 8,640 次/月（< 500K 免费额度 2%）
- 出网流量：仅向企微 webhook POST 文本，几乎为零；图片走已有 CDN，不计入新增流量
- 唯一风险：7 天无 API 调用自动暂停 → 已被「每 5 分钟调用」本身覆盖，另加 12h ping 双保险
