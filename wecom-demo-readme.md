# 企业微信群通知第一步验证说明

## 目标

先验证最小链路：

```text
本地脚本 → 企业微信群机器人 Webhook → 群内收到通知
```

这一步先不接个人提醒、日程、签到和后台，只验证最核心的群通知链路。

## 文件说明

| 文件 | 作用 |
|---|---|
| `wecom-demo.config.example.json` | 配置样例，不放真实 Webhook |
| `wecom-demo.config.json` | 你本地复制后填写真实 Webhook，建议不要上传或外发 |
| `send-wecom-demo.js` | 本地发送测试通知脚本 |
| `dify-workflow-first-step.md` | 后续接 Dify 的配置说明 |
| `wecom-demo-verification.md` | 验证记录模板 |

## 使用步骤

### 1. 在企业微信群添加机器人或消息推送

获取 Webhook，格式一般类似：

```text
https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxx
```

注意：Webhook 不要公开发到代码仓库、公开文档或群里。

### 2. 复制配置文件

复制：

```text
wecom-demo.config.example.json
```

另存为：

```text
wecom-demo.config.json
```

然后把：

```json
"webhookUrl": "YOUR_WECHAT_WORK_GROUP_BOT_WEBHOOK_URL"
```

替换成真实 Webhook。

### 3. 修改测试活动信息

在 `wecom-demo.config.json` 里按需修改：

```json
{
  "title": "新员工安全培训",
  "type": "培训",
  "startTime": "2026-07-24 14:00",
  "endTime": "2026-07-24 16:00",
  "location": "3F培训室 / 腾讯会议",
  "materialsUrl": "https://example.com/training-materials",
  "owner": "张三",
  "audience": "新员工培训群",
  "note": "请大家提前10分钟入场，并按时完成签到。"
}
```

### 4. 运行发送脚本

在当前目录运行：

```bash
C:/Users/PC/.workbuddy/binaries/node/versions/22.22.2/node.exe send-wecom-demo.js
```

如果你的配置文件放在其他路径，也可以指定：

```bash
C:/Users/PC/.workbuddy/binaries/node/versions/22.22.2/node.exe send-wecom-demo.js path/to/config.json
```

## 成功标准

满足以下条件即视为第一步成功：

- 终端显示企业微信返回 `errcode: 0`；
- 测试群收到一条 Markdown 格式的培训 / 会议 / 活动提醒；
- 群内展示效果可接受；
- 后续可将同样的 Webhook 调用迁移到 Dify 或后端服务中。

## 常见问题

### 1. 返回 webhook key invalid

可能原因：

- Webhook 填错；
- key 被复制时缺失；
- 群机器人被删除或重建。

### 2. 群里没有收到消息

先看终端返回：

- 如果 `errcode` 不是 0，以返回错误为准；
- 如果 `errcode` 是 0，但群里没有消息，检查是否发到了正确群的 Webhook。

### 3. markdown 展示不符合预期

第一版只是验证链路，模板可以后续继续调整。

### 4. Dify 是否现在就接

建议顺序：

```text
先用本地脚本打通 → 再用 Dify 调同一个 Webhook
```

这样最容易判断问题出在企微、Dify，还是网络 / 参数格式。
