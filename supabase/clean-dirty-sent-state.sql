-- 培训通知助手 v10 · 一键清理脏发送状态
-- 用途：清掉"立即发送测试"留下的脏 status=sent 记录，避免 send-due-scheduled 的 reconcile 阶段
--       把它回灌到 n.sentAudiences/sentAt，导致定时发送永远被 continue 跳过。
-- 用法：Supabase 控制台 → SQL Editor → New query → 粘贴本文件 → Run
-- 影响范围：仅删除 1 条 sendId 记录，幂等（可重复执行）；其余数据不动。
-- 备份：执行前可在 SQL Editor 先跑 SELECT 看一眼要删什么：
--     SELECT * FROM tn_sends WHERE id = 'p1785919878391:idmtb7ypj2nm9o:student:main';

-- Step 1. 确认要删的记录（先 SELECT 看一眼，再注释掉 DELETE 重跑）
SELECT id, status, claimed_by, sent_at, last_error
FROM tn_sends
WHERE id = 'p1785919878391:idmtb7ypj2nm9o:student:main';

-- Step 2. 执行删除（幂等，已删除则不影响）
DELETE FROM tn_sends
WHERE id = 'p1785919878391:idmtb7ypj2nm9o:student:main';

-- Step 3. 顺手也清理这个项目的同通知可能存在的 reminder1d/reminder2h 脏记录（保险）
DELETE FROM tn_sends
WHERE id LIKE 'p1785919878391:idmtb7ypj2nm9o:%';

-- Step 4. 验证：跑完应该返回 0 行
SELECT COUNT(*) AS remaining
FROM tn_sends
WHERE id LIKE 'p1785919878391:idmtb7ypj2nm9o:%';

-- Step 5. （可选）手动触发一次 send-due-scheduled 看是否成功发送
--  Supabase 控制台 → Edge Functions → send-due-scheduled → Invoke now
--  或 curl: curl -X POST 'https://qyxxchifknfmvvyjvoue.supabase.co/functions/v1/send-due-scheduled' \
--    -H "Authorization: Bearer <anon_key>" -H "Content-Type: application/json" -d '{}'
--  返回值里 sent 应包含 "p1785919878391/idmtb7ypj2nm9o/student"