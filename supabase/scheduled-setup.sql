-- ============================================================================
-- 培训通知助手 · 云端定时发送调度（方案 A）
-- ============================================================================
-- 作用：用 Supabase 自带的 pg_cron 每 5 分钟调用 send-due-scheduled Edge Function，
--       由云端基础设施完成定时发送，不依赖你的电脑 / 不依赖 GitHub Action。
--
-- 前置：
--   1) 已部署 Edge Function send-due-scheduled（见 supabase/functions/send-due-scheduled/index.ts）
--   2) 已在该函数的 Secrets 中设置 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY
--   3) 把下面 <YOUR_SUPABASE_URL> 与 <YOUR_SUPABASE_ANON_KEY> 替换为你的真实值
--      - SUPABASE_URL：项目 URL，形如 https://qyxxchifknfmvvyjvoue.supabase.co
--      - ANON_KEY：Settings → API → anon public key（仅用于"触发"函数，函数内部用 service_role 读库）
--
-- 执行方式：Supabase 控制台 → SQL Editor → 粘贴本文件 → Run
-- 取消调度（如需）：select cron.unschedule('send-due-scheduled'); select cron.unschedule('keepalive-supabase');
-- ============================================================================

-- 启用扩展（免费版可用；若 pg_net 启用失败，见文件底部 Dashboard 备选方案）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 调度 1：每 5 分钟触发定时发送（主力）
select cron.schedule(
  'send-due-scheduled',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := '<YOUR_SUPABASE_URL>/functions/v1/send-due-scheduled',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <YOUR_SUPABASE_ANON_KEY>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);

-- 调度 2：每 12 小时保活 ping（双保险，防止免费版 7 天无活动自动暂停）
--   注：上面的 5 分钟调度本身已是高频 HTTP 活动，足以保活；此条为额外保险。
select cron.schedule(
  'keepalive-supabase',
  '23 */12 * * *',
  $$
  select net.http_post(
    url := '<YOUR_SUPABASE_URL>/functions/v1/send-due-scheduled?ping=1',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <YOUR_SUPABASE_ANON_KEY>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);

-- ============================================================================
-- 验证
-- ============================================================================
-- 查看已建调度：
--   select jobid, jobname, schedule, active from cron.job;
-- 查看最近执行（保留期有限）：
--   select * from cron.job_run_details order by start_time desc limit 20;
--
-- ============================================================================
-- 备选方案（若 pg_net 在你的免费组织无法启用）：
--   不使用本 SQL，改为在 Supabase 控制台 → Edge Functions → send-due-scheduled →
--   Schedules（计划）→ 新建调度，Cron 表达式填  */5 * * * *  → 保存。
--   该方式由 Supabase 直接调用函数，无需 pg_net，同样每 5 分钟运行、同样起到保活作用。
--   保活 ping 可省略（5 分钟调度已足够），或额外建一个 23 */12 * * * 的调度指向 ?ping=1。
-- ============================================================================
