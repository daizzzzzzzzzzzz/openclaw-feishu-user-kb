# openclaw-feishu-user-kb

`openclaw-feishu-user-kb` 是一个给 OpenClaw 使用的飞书知识库插件。它的核心目标不是替代飞书官方机器人通道，而是补上一个关键能力缺口: 让 OpenClaw 在飞书消息上下文里，使用 `user_access_token` 而不是 `tenant_access_token` 去操作知识库、云文档和多维表格。

这解决的是一个常见问题: 机器人明明已经拿到很多租户级权限，但在实际调用飞书知识库 API 时，仍然会因为“当前调用身份不是文档所有者”或“不能代表具体用户”而无法迁移云文档、写入知识库页面、移动知识库节点。这个插件通过浏览器 OAuth 绑定单一飞书用户，把这些操作切到用户态执行。

本仓库只包含插件源码、测试和安装说明，不包含任何真实凭证、日志、会话文件或运行缓存。

## 它是干什么的

这个插件为 OpenClaw 增加一个工具: `feishu_user_kb`。

它支持下面这些能力:

- 通过本地浏览器完成飞书 OAuth 授权，拿到 `user_access_token`
- 在知识库中创建 `docx` 页面
- 读取、覆盖写入、追加写入知识库页面
- 重命名和移动知识库节点
- 把已有云文档迁移到知识库
- 查询知识库异步任务状态
- 创建和读取知识库中的 `bitable`
- 创建 `bitable` 数据表、字段和记录
- 基于 `feishu_docx_ai_v1` 规范，对 Markdown 写入做兼容性分析并给出风险提示

## 适用场景

- 你已经用 OpenClaw 接入了飞书消息通道，但官方 `doc/wiki` 工具因为 `tenant_access_token` 身份限制不够用
- 你希望机器人能够真正创建、编辑、移动知识库内容，而不是只读
- 你希望把 AI 写作结果稳定落到飞书 `docx` 页面中
- 你希望把结构化知识沉淀到 `bitable`

## 不适用场景

- 你需要删除知识库节点、删除页面、删除记录
- 你需要多用户共用同一插件实例并分别绑定自己的 user token
- 你需要把飞书知识库页面当成原生 Markdown 文件使用
- 你希望在 CLI 或非飞书消息上下文中随意调用这个工具

## 框架与技术栈

本插件保持最小依赖，直接使用 OpenClaw 插件机制和 Node.js ESM 实现。

- 运行时: Node.js ESM
- 插件机制: OpenClaw extension / plugin API
- 飞书 SDK: `@larksuiteoapi/node-sdk`
- 参数 schema: `@sinclair/typebox`
- 测试: Node 内置 `node --test`

## 功能总览

### 1. 用户态授权

插件会在本地 OpenClaw gateway 上注册两个 HTTP 路由:

- `GET /plugins/feishu-user-kb/auth/start?accountId=<id>`
- `GET /plugins/feishu-user-kb/auth/callback?code=<code>&state=<state>`

用户点击授权链接后，插件会:

1. 生成一次性 state
2. 跳转到飞书 OAuth 授权页
3. 在回调中用 `code` 换取 `user_access_token`
4. 读取当前授权用户信息
5. 把该账号绑定为单一 owner

### 2. 知识库 `docx`

当前插件已经支持这些 `docx` / wiki 动作:

- `auth_status`
- `start_auth`
- `spaces`
- `nodes`
- `get_node`
- `create_page`
- `read_page`
- `write_page`
- `append_page`
- `rename_node`
- `move_node`
- `move_doc_to_wiki`
- `get_task`

说明:

- `write_page` 和 `append_page` 输入的是 Markdown 风格文本，但飞书实际存储的是 `docx` 块文档
- 插件会先做 Markdown 兼容性分析，再调用飞书转换接口
- 返回结果里会带 `format_profile`、`compatibility`、`warnings`、`recommendations`

### 3. `bitable`

当前插件已经支持这些多维表格动作:

- `get_bitable`
- `create_bitable`
- `list_bitable_tables`
- `create_bitable_table`
- `list_bitable_fields`
- `create_bitable_field`
- `list_bitable_records`
- `get_bitable_record`
- `create_bitable_record`
- `update_bitable_record`

### 4. `feishu_docx_ai_v1` 写作规范

仓库内置一套给 AI 使用的内容格式范式，目的是让知识库内容更稳定、更可读，也更容易持续编辑。

核心原则是:

- 长篇正文优先放 `docx`
- 结构化事实优先放 `bitable`
- 原始 Markdown、PDF、合同、附件等高保真材料优先保留为原始文件
- 避免把高复杂度 Markdown 直接硬塞给 `docx`

## 目录结构

```text
openclaw-feishu-user-kb/
  .github/workflows/ci.yml
  examples/openclaw.config.example.json
  src/
  test/
  index.js
  openclaw.plugin.json
  package.json
  README.md
```

## 安装方式

### 方式一: 作为独立仓库 clone

```powershell
git clone https://github.com/daizzzzzzzzzzzz/openclaw-feishu-user-kb.git
cd openclaw-feishu-user-kb
npm install
```

说明:

- 这里已经改成当前仓库的真实地址
- 如果别人是从你这个仓库直接安装，这段命令可以原样使用
- 如果别人是 fork 到自己的账号后再安装，需要把地址换成自己的 fork URL

### 方式二: 安装到 OpenClaw 扩展目录

推荐把仓库放到 `~/.openclaw/extensions/openclaw-feishu-user-kb`。

Windows 直接复制:

```powershell
Copy-Item -Recurse -Force . "$env:USERPROFILE\\.openclaw\\extensions\\openclaw-feishu-user-kb"
```

Windows 软链接:

```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\\.openclaw\\extensions\\openclaw-feishu-user-kb" `
  -Target "<你的本地仓库路径>"
```

说明:

- `~/.openclaw/extensions/openclaw-feishu-user-kb` 和 `$env:USERPROFILE\\.openclaw\\extensions\\openclaw-feishu-user-kb` 是通用的 OpenClaw 扩展目录写法
- 我之前写的 `D:\\AI\\openclaw-feishu-user-kb` 是当前这台机器上的实际开发目录，只适用于这台电脑，不应该原样保留在公开文档里
- 公开 README 里，软链接目标应该写成你自己的实际本地路径，例如 `D:\\Projects\\openclaw-feishu-user-kb` 或 `C:\\work\\openclaw-feishu-user-kb`

安装完成后，重启 OpenClaw gateway 或执行你当前环境中的插件重载命令。

## OpenClaw 配置示例

示例文件见:

- [examples/openclaw.config.example.json](./examples/openclaw.config.example.json)

这个示例是一个“合并到你现有 `~/.openclaw/openclaw.json`”的最小片段，不是完整的全局配置。

关键点:

- 飞书消息通道仍然由官方 `feishu` 插件负责
- 本插件只负责用户态知识库能力
- 建议关闭官方 Feishu 账号上的 `tools.doc` 和 `tools.wiki`
- `plugins.allow` 和 `plugins.entries` 里要显式启用 `feishu-user-kb`

最小示例:

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "defaultAccount": "main",
      "accounts": {
        "main": {
          "appId": "cli_xxxxxxxxxxxxxxxxx",
          "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "tools": {
            "doc": false,
            "wiki": false
          }
        }
      }
    }
  },
  "plugins": {
    "allow": ["feishu", "feishu-user-kb"],
    "entries": {
      "feishu": {
        "enabled": true
      },
      "feishu-user-kb": {
        "enabled": true,
        "config": {
          "gatewayBaseUrl": "http://127.0.0.1:18789"
        }
      }
    }
  }
}
```

多账号场景也支持，但本插件的单次授权和 owner 绑定都是按 `accountId` 分开的。第一版不做多用户共享。

## 飞书应用准备

### 应用类型

推荐使用飞书自建应用。

### OAuth 回调地址

默认回调地址是:

```text
http://127.0.0.1:18789/plugins/feishu-user-kb/auth/callback
```

如果你给插件配置了其他 `gatewayBaseUrl`，回调地址也要跟着改。

### 所需权限

你至少需要为应用配置这些类别的能力:

- OAuth 用户授权能力
- 用户信息读取能力
- 知识库相关能力
- 云文档 / 新版文档相关能力
- `bitable` 相关能力

具体 scope 名称以你当前飞书开放平台控制台为准。飞书会持续调整权限命名和分组，本 README 不硬编码具体权限名。

### 所有者限制

这个插件不能绕过飞书的“当前操作人是谁”这一层限制。尤其是:

- 把已有云文档迁移到知识库时，授权用户通常需要是源文档所有者
- 授权用户还必须对目标知识库父节点有权限
- 只给应用加租户级权限，不会自动绕过这些限制

## 如何使用

这里的示例是 `feishu_user_kb` 工具的参数示意，方便你调试或阅读日志。实际使用时，通常是 OpenClaw 在飞书对话中替你调用。

### 1. 查看授权状态

```json
{
  "action": "auth_status"
}
```

如果还没授权，返回里会带 `auth_url`。打开它完成授权。

### 2. 发起授权

```json
{
  "action": "start_auth"
}
```

### 3. 列出知识库空间

```json
{
  "action": "spaces"
}
```

### 4. 在知识库中创建页面

```json
{
  "action": "create_page",
  "space_id": "wiki_space_xxx",
  "parent_node_token": "wiki_parent_xxx",
  "title": "OpenClaw 用户态知识库接入说明"
}
```

### 5. 覆盖写入页面

```json
{
  "action": "write_page",
  "node_token": "wiki_node_xxx",
  "content": "# 标题\n\n这是正文。\n\n- 列表项 A\n- 列表项 B"
}
```

### 6. 追加写入页面

```json
{
  "action": "append_page",
  "node_token": "wiki_node_xxx",
  "content": "## 新增章节\n\n这里是增量补充内容。"
}
```

### 7. 迁移已有云文档到知识库

```json
{
  "action": "move_doc_to_wiki",
  "space_id": "wiki_space_xxx",
  "obj_token": "doccnxxxxxxxxxxxxxxxx",
  "parent_node_token": "wiki_parent_xxx"
}
```

### 8. 创建 `bitable`

```json
{
  "action": "create_bitable",
  "space_id": "wiki_space_xxx",
  "parent_node_token": "wiki_parent_xxx",
  "title": "项目跟踪表"
}
```

### 9. 创建 `bitable` 字段

```json
{
  "action": "create_bitable_field",
  "app_token": "bascnxxxxxxxxxxxxxxxx",
  "table_id": "tblxxxxxxxx",
  "field_name": "状态",
  "field_type": 1
}
```

### 10. 新增 `bitable` 记录

```json
{
  "action": "create_bitable_record",
  "app_token": "bascnxxxxxxxxxxxxxxxx",
  "table_id": "tblxxxxxxxx",
  "fields": {
    "任务": "整理插件仓库",
    "状态": "进行中"
  }
}
```

## 注意事项

### 1. 单用户 owner 绑定

每个 `accountId` 首次授权成功后，会绑定到单一飞书 owner。之后只有这个 owner 在飞书消息上下文里触发工具时，插件才会放行。不会降级回 `tenant_access_token`。

### 2. 只允许 Feishu 消息上下文调用

这个插件设计目标就是“让飞书里的机器人代某个具体用户操作知识库”。因此它会校验:

- `messageChannel === "feishu"`
- 当前 sender 是否和已绑定 owner 一致

如果你在 CLI、本地调试面板或其他消息通道里直接调用，通常会被拒绝。

### 3. `docx` 不是原生 Markdown

飞书知识库页面本质上是 `docx` 块文档，不是原生 `.md` 文件。基础 Markdown 通常可以稳定转换，但这些内容经常会降级:

- 高密度表格
- 原始 HTML
- Mermaid
- LaTeX / 数学公式文本
- 脚注
- 复杂嵌套列表
- 很长的代码块拼接

### 4. 高表格密度内容优先用 `bitable`

如果你的内容天然是行列结构，比如 FAQ、术语表、项目追踪、客户线索，不要强行写进 `docx` 表格，优先放 `bitable`。

### 5. 原稿保真需求优先原始文件

如果你更在意 Markdown、PDF、合同、设计稿、规范原文的保真，不要把它们都转成 `docx`。应当把原稿作为附件或原始文件存放到知识库，再在 `docx` 页面里写导读和索引。

### 6. 凭证存储与刷新

授权后，插件会把用户态凭证保存在本地:

```text
~/.openclaw/credentials/feishu-<accountId>-user-auth.json
```

行为规则:

- access token 快过期时会自动刷新
- 刷新失败不会删除旧文件，只会返回重新授权提示
- 同一账号的回调写入和刷新是串行化处理的

## 开发与测试

### 安装依赖

```powershell
npm install
```

如果你在某些受限的 Windows 环境里遇到依赖 `postinstall` 被拦截，可以改用:

```powershell
npm ci --ignore-scripts
```

### 运行测试

```powershell
npm test
```

### 本地接入 OpenClaw 验证

建议按这个顺序做冒烟验证:

1. 把插件放进 `~/.openclaw/extensions/openclaw-feishu-user-kb`
2. 在 `~/.openclaw/openclaw.json` 中启用 `feishu-user-kb`
3. 确认官方 Feishu 账号的 `tools.doc` 和 `tools.wiki` 已关闭
4. 重启 OpenClaw gateway
5. 用 `plugins list` 确认插件状态为 `loaded`
6. 从飞书里触发一次 `auth_status`
7. 完成浏览器授权
8. 再从飞书里触发 `spaces`、`create_page`、`get_bitable`

## 常见问题 / 限制

### `auth_required`

说明当前账号还没有完成用户态授权。打开返回里的 `auth_url` 即可。

### `reauthorization_required`

说明现有 refresh 失败，或飞书侧 token 状态已经不可继续使用。重新授权即可。

### `unauthorized_requester`

说明当前消息发送者不是该 `accountId` 已绑定的 owner，或者 sender 身份无法通过校验。

### `Trusted Feishu sender identity is missing from the current tool context`

说明当前工具调用没有拿到可信的飞书 sender 身份。插件会尝试从同一会话的最新飞书入站消息中恢复 sender，但这仍然要求:

- 本次调用确实来自飞书会话
- OpenClaw 会话状态存在
- 恢复出的 sender 和 owner 完全一致

### 为什么会丢 Markdown 格式

因为飞书知识库页面不是原生 Markdown。插件会尽量做兼容转换和风险提示，但不会承诺 100% 保真。

### 为什么这个插件不提供删除能力

这是刻意收紧的边界。当前仓库只实现创建、读取、更新、移动、迁移，不提供删除类动作，避免误删知识资产。

## 发布前需要改的地方

当前仓库的 `package.json` 已经写入真实 `repository.url`:

```text
git+https://github.com/daizzzzzzzzzzzz/openclaw-feishu-user-kb.git
```

只有在下面两种情况时，你才需要再改:

- 你把仓库改名了
- 你把这个项目 fork 到其他 GitHub 账号名下，准备以 fork 作为主仓库继续维护

获取方式:

1. 先在 GitHub 上创建一个新仓库，例如 `openclaw-feishu-user-kb`
2. 打开这个仓库首页
3. 复制浏览器地址栏里的页面 URL，例如:

```text
https://github.com/daizzzzzzzzzzzz/openclaw-feishu-user-kb
```

4. 再把它转换成 `package.json` 里常用的 git URL 格式:

```text
git+https://github.com/daizzzzzzzzzzzz/openclaw-feishu-user-kb.git
```

例如，如果你的 GitHub 用户名是 `zhangsan`，仓库名是 `openclaw-feishu-user-kb`，那么:

- 仓库页面 URL:

```text
https://github.com/zhangsan/openclaw-feishu-user-kb
```

- `package.json` 中的 `repository.url`:

```text
git+https://github.com/zhangsan/openclaw-feishu-user-kb.git
```

## License

MIT
