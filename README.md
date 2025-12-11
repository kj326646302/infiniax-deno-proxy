# infiniax-deno-proxy

将 [infiniax.ai](https://infiniax.ai) 的聊天 API 转换为 OpenAI 兼容格式的代理服务。

## 特性

- 🚀 单文件实现，零外部依赖
- 🔄 完全兼容 OpenAI API 格式
- 📡 支持流式和非流式响应
- 🔍 支持 Web Search 功能
- ☁️ 支持 Deno Deploy 一键部署

## 部署到 Deno Deploy

### 方法一：通过 GitHub 部署（推荐）

1. Fork 或上传此仓库到你的 GitHub
2. 访问 [Deno Deploy](https://dash.deno.com)
3. 点击 "New Project"
4. 选择你的 GitHub 仓库
5. 设置入口文件为 `main.ts`
6. 添加环境变量：
   - `INFINIAX_COOKIE`: 你的 infiniax.ai Cookie

### 方法二：通过 deployctl 部署

```bash
# 安装 deployctl
deno install -Arf jsr:@deno/deployctl

# 部署
deployctl deploy --project=your-project-name main.ts
```

然后在 Deno Deploy 控制台设置环境变量 `INFINIAX_COOKIE`。

## 获取 Cookie

1. 访问 [infiniax.ai](https://infiniax.ai) 并登录
2. 打开浏览器开发者工具 (F12)
3. 切换到 Network 标签
4. 发送一条消息
5. 找到 `stream` 请求，复制 Cookie 头的值（格式：`connect.sid=...`）

## 本地运行

```bash
# 设置环境变量并运行
INFINIAX_COOKIE="connect.sid=..." deno run --allow-net --allow-env main.ts

# 或指定端口
PORT=8080 INFINIAX_COOKIE="connect.sid=..." deno run --allow-net --allow-env main.ts
```

## API 使用

### Chat Completions

```bash
curl https://your-project.deno.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### 启用 Web Search

```bash
curl https://your-project.deno.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-5.1-codex-max",
    "messages": [{"role": "user", "content": "今天北京天气怎么样？"}],
    "stream": false,
    "web_search": true
  }'
```

### 流式响应

```bash
curl https://your-project.deno.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o",
    "messages": [{"role": "user", "content": "Count 1 to 5"}],
    "stream": true
  }'
```

### 获取模型列表

```bash
curl https://your-project.deno.dev/v1/models
```

## 在 OpenAI SDK 中使用

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-project.deno.dev/v1",
    api_key="not-needed"  # 任意值即可
)

response = client.chat.completions.create(
    model="openai/gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### Node.js

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://your-project.deno.dev/v1',
  apiKey: 'not-needed'
});

const response = await client.chat.completions.create({
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }]
});
console.log(response.choices[0].message.content);
```

## 支持的模型

代理支持 infiniax.ai 上的所有模型，包括：

| Provider | Models |
|----------|--------|
| OpenAI | gpt-5.1, gpt-5.1-codex-max, gpt-4o, gpt-4-turbo, gpt-3.5-turbo |
| Anthropic | claude-opus-4.1, claude-sonnet-4.5, claude-haiku-4.5 |
| Google | gemini-2.5-pro, gemini-2.5-flash |
| Meta | llama-4-maverick, llama-3.3-70b-instruct |
| DeepSeek | deepseek-v3.1-terminus, deepseek-chat |
| X.AI | grok-4, grok-4.1-fast |
| Qwen | qwen3-max, qwen3-coder-plus |
| ... | 更多模型请查看 `/v1/models` |

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `INFINIAX_COOKIE` | ✅ | - | infiniax.ai 的认证 Cookie |
| `PORT` | ❌ | 3000 | 服务器端口（本地运行时） |

## 运行测试

```bash
deno test --allow-net --allow-env
```

## License

MIT
