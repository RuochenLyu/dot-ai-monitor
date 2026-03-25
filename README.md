# dot-ai-monitor

在 [Dot 电子墨水屏](https://www.dotmemory.cn/) 上显示 Claude Code 会话状态和 AI 用量信息。

![session status](https://img.shields.io/badge/session-status-black) ![ai usage](https://img.shields.io/badge/ai-usage-black)

## 它做什么

- **有活跃会话时**：实时显示每个 Claude Code 会话的状态（运行中 / 需要权限 / 已完成）
- **空闲时**：显示 Claude 和 Codex 的 token 用量（5 小时 / 7 天窗口 + 进度条）
- 会话状态通过 Claude Code Hooks 自动推送，用量信息通过 cron 定时刷新

## 前置条件

- [Dot 设备](https://www.dotmemory.cn/)，接入电源和网络
- 在 Dot App 内容工坊中添加「图像 API」到设备任务
- Node.js 18+
- Claude Code CLI

## 安装

```bash
git clone https://github.com/yourname/dot-ai-monitor.git
cd dot-ai-monitor
npm install
```

创建 `.env` 文件：

```env
# Dot 设备（必填）
DOT_API_KEY=dot_app_your_api_key
DOT_DEVICE_ID=YOUR_DEVICE_ID
DOT_BASE_URL=https://dot.mindreset.tech

# AI 用量显示（可选，不填则空闲时不显示用量）
RELAY_BASE_URL=https://your-relay-url.com
RELAY_ADMIN_API_KEY=your_admin_key
RELAY_CLAUDE_ACCOUNT_ID=1
TZ=Asia/Shanghai
```

## 配置 Claude Code Hooks

在 `~/.claude/settings.json` 中添加：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /path/to/dot_notify.js", "timeout": 5, "async": true }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "node /path/to/dot_notify.js", "timeout": 5, "async": true }] }
    ],
    "Notification": [
      { "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "node /path/to/dot_notify.js", "timeout": 5, "async": true }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /path/to/dot_notify.js", "timeout": 5, "async": true }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node /path/to/dot_notify.js", "timeout": 5, "async": true }] }
    ]
  }
}
```

将 `/path/to/dot_notify.js` 替换为实际路径。

## 配置定时用量刷新

```bash
chmod +x dot_usage.sh
crontab -e
```

添加（每 10 分钟，7:00-23:59）：

```
*/10 7-23 * * * /path/to/dot_usage.sh
```

## 会话状态说明

| 屏幕显示 | 含义 |
|---------|------|
| 项目名 + `···` | Claude 正在运行 |
| 项目名 + `(!)` | Claude 等待权限确认 |
| 项目名（反色行）+ `✓` | Claude 已完成，等你查看 |

- 已完成/权限状态 3 分钟后自动过期
- 最后一个会话结束后自动切换到用量显示
- 支持同时显示最多 3 个会话

## 测试

```bash
# 推送混合状态测试图
node dot_notify.js --test mix

# 推送用量信息
node dot_notify.js --test usage

# 其他测试场景
node dot_notify.js --test all-run
node dot_notify.js --test all-done
node dot_notify.js --test single
```

## 文件结构

```
├── dot_notify.js      # 主程序
├── dot_usage.sh       # cron 入口
├── package.json
├── .env               # 配置（不提交）
└── .cache/            # 运行时缓存（自动创建）
```

## License

ISC
