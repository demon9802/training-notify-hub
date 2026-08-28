# Dify Workflow 第一阶段接入说明

## 目标

在本地脚本验证企微群机器人可用后，再用 Dify Workflow 跑通：

```text
输入活动信息 → Dify 生成通知文案 → HTTP 请求节点调用企微 Webhook → 群里收到通知
```

## 推荐 Workflow 节点

### 节点 1：开始节点

输入字段建议：

| 字段 | 类型 | 示例 |
|---|---|---|
| `title` | 文本 | 新员工安全培训 |
| `type` | 文本 | 培训 |
| `start_time` | 文本 | 2026-07-24 14:00 |
| `end_time` | 文本 | 2026-07-24 16:00 |
| `location` | 文本 | 3F培训室 / 腾讯会议 |
| `audience` | 文本 | 新员工培训群 |
| `owner` | 文本 | 张三 |
| `materials_url` | 文本 | https://example.com/training-materials |
| `note` | 文本 | 请大家提前10分钟入场，并按时完成签到。 |

### 节点 2：LLM 文案生成节点

提示词示例：

```text
你是企业微信通知助手。请根据以下活动信息生成一条适合企业微信群发送的 Markdown 通知。

要求：
1. 简洁、正式、清晰。
2. 开头使用：【{type}提醒】{title}
3. 包含时间、地点、对象、负责人、材料链接。
4. 最后一行提醒成员按时参加。
5. 输出纯 Markdown 文本，不要解释。

活动信息：
- 类型：{{type}}
- 标题：{{title}}
- 开始时间：{{start_time}}
- 结束时间：{{end_time}}
- 地点：{{location}}
- 对象：{{audience}}
- 负责人：{{owner}}
- 材料链接：{{materials_url}}
- 备注：{{note}}
```

### 节点 3：HTTP 请求节点

请求方法：

```text
POST
```

请求 URL：

```text
企业微信群机器人 Webhook
```

请求头：

```json
{
  "Content-Type": "application/json"
}
```

请求体：

```json
{
  "msgtype": "markdown",
  "markdown": {
    "content": "{{LLM节点输出内容}}"
  }
}
```

注意：不同 Dify 版本变量引用方式可能略有差异，以 Dify 节点变量选择器为准。

### 节点 4：结束节点

返回：

- 企业微信接口返回结果；
- 本次生成的通知内容；
- 是否发送成功。

## 验证标准

| 项目 | 标准 |
|---|---|
| Dify 能运行 | Workflow 可以手动运行成功 |
| 企微能收到 | 测试群收到 Dify 发出的消息 |
| 文案可用 | 群里展示清晰、正式、无明显 AI 冗余 |
| 可继续扩展 | 后续可增加定时触发、Webhook 触发或后端调用 Dify |

## 后续扩展方向

第一步跑通后，可以继续扩展：

1. Dify 定时触发器：用于固定时间推送。
2. Dify Webhook 触发器：由外部系统传入活动信息。
3. 轻量后端调用 Dify：后端负责活动数据和调度，Dify 负责生成文案。
4. 企业微信自建应用：用于个人提醒和日程接口。

## 建议顺序

```text
本地脚本验证企微 Webhook
        ↓
Dify 手动运行 Workflow
        ↓
Dify 定时或 Webhook 触发
        ↓
轻量后端统一调度
```
