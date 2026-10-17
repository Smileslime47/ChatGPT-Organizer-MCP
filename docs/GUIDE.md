# 开发与维护指南

## 独立浏览器

默认使用独立浏览器模式（`CHATGPT_TRANSPORT=playwright`），自动寻找 Chrome、Edge、Chromium 的常规安装或 Playwright 已安装的 Chromium。浏览器资料保存在专用目录，不使用日常浏览器的资料。

首次调用 `chatgpt_open_browser` 会以普通窗口打开 ChatGPT，不附加自动化或调试连接。在官网选择登录方式，完成登录并关闭专用窗口，再调用一次 `chatgpt_open_browser`，MCP 就会使用同一浏览器和资料目录连接。后续直接复用有效登录；登录失效时，重新调用此工具进入普通登录窗口。也可用 `chatgpt-organizer --login` 提前登录；源码环境使用 `npm run login`。

登录方式由 ChatGPT 官网提供，无需在 MCP 中配置 Google、邮箱或其他身份提供方。整理阶段使用 Chromium 系浏览器，Firefox 和 Safari 当前不能作为连接目标。

没有可用浏览器时，运行 `npx playwright@1.64.1 install chromium`；源码环境可运行 `npm run install-browser`。自动探测覆盖 Windows、macOS 和 Linux 的常见安装位置，自定义位置可设置 `CHATGPT_BROWSER_EXECUTABLE`。

选定的浏览器会保存在数据目录中，后续保持使用同一程序。更换浏览器时，设置新的 `CHATGPT_DATA_DIR` 并重新登录，避免不同浏览器共用资料。退出 MCP 会关闭由它控制的专用窗口。

## 可选 Chrome 直接连接

设置 `CHATGPT_TRANSPORT=chrome` 可复用正在运行的 Chrome 144+。首次在地址栏打开 `chrome://inspect/#remote-debugging`，开启允许远程调试；调用 `chatgpt_open_browser` 时，在 Chrome 原生弹窗确认连接。MCP 初始化和 `chatgpt_status` 不触发连接授权。

先在未连接的浏览器中完成 ChatGPT 登录，再连接 MCP。连接后自动选择已登录的 ChatGPT 页面，没有页面时打开新页。退出 MCP 仅断开连接，不关闭日常浏览器或标签页。

Chrome 的授权范围是整个浏览器实例，不是单个站点。本工具只在 ChatGPT 页面检查登录、请求相关接口及记录操作；录制固定在选中的页面，页面关闭或离开 ChatGPT 后必须重新录制。切换账号或工作区后应重新连接、查询并生成计划。

参考 [Chrome 官方授权连接说明](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)。官方 [Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart) 不授予 ChatGPT 会话访问权限，不能代替浏览器连接。

## 发布

运行 `npm ci` 安装依赖，再运行 `npm run package`。命令编译 TypeScript，并在 `release/` 生成 Chrome 扩展 ZIP 和 MCP 的 npm TGZ。扩展包包含运行资源和许可证，MCP 包包含已编译入口、中英文 README 和许可证；不包含源码、测试、sourcemap、浏览器资料或连接密钥。

### 可选扩展发布

默认模式不需要扩展。以下只适用于要分发扩展模式的维护者。

1. 在 [Chrome 开发者后台](https://chrome.google.com/webstore/devconsole) 创建扩展条目，上传 ZIP 草稿。
2. 在条目的 **Package → View public key** 复制公钥，去掉 PEM 首尾标记和换行，写入 `extension/manifest.json` 的 `key`。
3. 递增 `package.json` 和扩展 manifest 的 `version`，运行 `npm install --package-lock-only --ignore-scripts` 同步锁文件，再运行 `npm run package`。把新版本 ZIP 上传到**同一条目**，同时使用这次生成的 MCP TGZ。
4. 填写商店介绍、截图和隐私信息，完成审核与发布，再把商店安装链接加入 README。

MCP 根据公钥识别允许连接的扩展。仓库中的开发公钥不能保证与商店分配的身份相同，因此应先同步公钥，再分发 MCP。后续版本保留同一公钥，递增两处版本并同步锁文件。商店要求每次上传使用更高的版本号，参见[上传准备](https://developer.chrome.com/docs/webstore/prepare)。下文文件名以 `1.0.0` 为例，发布时使用实际生成的版本。

ZIP 根目录已包含 manifest 和 16/32/48/128 像素图标。ZIP 是商店上传包；Windows/macOS 普通用户通过商店安装，自托管 CRX 的安装受企业策略限制。参考 Chrome 官方的[发布流程](https://developer.chrome.com/docs/webstore/publish)、[公钥说明](https://developer.chrome.com/docs/extensions/reference/manifest/key)和[分发方式](https://developer.chrome.com/docs/extensions/how-to/distribute)。

### MCP 安装包

TGZ 内包含 `chatgpt-organizer` 命令。README 中的 `npx --package=/绝对路径/安装包.tgz chatgpt-organizer` 可直接使用该文件，无需安装 TypeScript 或编译源码。客户端负责启动和关闭进程。

也可以把生成的 TGZ 发布到有权限使用的 npm 包名下：

```sh
npm publish release/chatgpt-organizer-mcp-1.0.0.tgz --access public
```

发布前确认包名可用；如需更名，修改 `package.json` 的 `name`，更新锁文件并重新打包。扩展 ZIP 名称不变，TGZ 名称随 npm 包名变化。公开发布完成后，把客户端的 `--package` 参数换为实际发布的 `包名@版本`，用户便不需要下载 TGZ。不要在发布前提供尚不存在的 npm 安装命令。

首次通过 npx 启动会安装依赖。若客户端默认启动等待时间较短，可延长到 60 秒；如果找不到 npx，指定其可执行文件的绝对路径。

## 开发

```sh
npm ci
npm run check
npm test
```

`npm ci` 自动编译；修改 TypeScript 后运行 `npm run build`。`extension/src/` 为扩展源码；`dist/` 和 `extension/*.js` 是构建产物。服务端按职责分层：

```text
src/
├─ app/          CLI、MCP 工具和会话实现的装配
├─ core/         整理业务、接口契约和路由规则
├─ browser/      共用会话行为
│  ├─ chromium/  独立浏览器与 Chrome 直连
│  └─ extension/ 扩展连接与桥接协议
├─ storage/      路由模板持久化和数据路径
├─ tools/        诊断与发布命令
├─ index.ts      命令入口
└─ index.js      旧配置的兼容入口
```

`app` 负责组合具体实现；`browser` 和 `storage` 依赖 `core` 的契约，`core` 不依赖它们或 MCP SDK。项目接口的校验、学习和渲染在 `core/routes.ts`，JSON 文件读写在 `storage/routes.ts`。构建后的命令入口保持为 `dist/index.js`。

开发可选扩展时，在 `chrome://extensions` 开启开发者模式，加载仓库的 `extension/` 目录，并在 MCP 环境变量设置 `CHATGPT_TRANSPORT=extension`。重新构建后点击扩展的重新加载按钮。扩展尚无商店链接；需要时可自行上架，默认模式不受影响。

开发用 MCP 配置：

```json
{
  "mcpServers": {
    "chatgpt-organizer": {
      "command": "node",
      "args": ["/absolute/path/to/ChatGPT-Mcp/dist/index.js"]
    }
  }
}
```

需要交互诊断时可运行 `npm run doctor`，它会启动 MCP。回车执行只读检查，`exit` 退出。也可输入 `call {"name":"工具名","arguments":{...}}` 调用工具；`chatgpt_execute_plan` 会实际修改账号数据。使用诊断前关闭占用相同连接端口的 MCP 实例。

## 浏览器适配

MCP 工具依赖 `src/core/session.ts` 的 `BrowserSession` 接口，统一初始化、登录、连接、状态查询、后台请求、项目接口记录和关闭。会话整理逻辑只需要其中的 `request()`；Cookie 和登录令牌仍在浏览器内使用。

`src/app/session-factory.ts` 按配置选择实现：`StandaloneBackend` 管理独立 Chromium 系浏览器，`ChromeBackend` 连接日常 Chrome，`ExtensionBackend` 通过扩展连接。Chrome、Edge 和 Chromium 共用独立浏览器实现。

添加浏览器时，在 `src/browser/` 下实现 `BrowserSession` 并在工厂中注册。请求校验与模板记录可复用 `browser/base.ts` 的 `SessionBackend`，页面内请求可复用 `browser/page.ts` 的 `PageSession`；两者均不依赖 Playwright。具体实现负责自己的启动、登录持久化及关闭行为，不向上层暴露窗口对象、进程或扩展服务。Firefox、Safari 尚未提供实现。

## 工具

| 工具 | 用途 |
| --- | --- |
| `chatgpt_status` | 检查登录、连接及项目接口校准状态 |
| `chatgpt_open_browser` | 打开登录窗口，或连接已登录的 ChatGPT |
| `chatgpt_list_conversations` | 分页读取会话标题、ID、时间、归档状态等元数据 |
| `chatgpt_search_conversations` | 按标题子串搜索，返回扫描范围是否完整 |
| `chatgpt_get_conversation` | 查询详情，可选当前分支最后 1–30 条文字消息 |
| `chatgpt_list_projects` | 读取项目列表，需校准 |
| `chatgpt_list_project_conversations` | 读取项目内会话，需校准 |
| `chatgpt_preview_changes` | 预览最多 50 个修改动作，不写入 ChatGPT |
| `chatgpt_execute_plan` | 执行指定预览计划 |
| `chatgpt_record_start` / `chatgpt_record_finish` | 记录并保存项目接口模板 |

支持动作：`rename_conversation`、`archive_conversation`（`archived=false` 恢复）、`create_project`、`rename_project`、`move_conversation`。后三项需要校准。

预览返回 `plan_id`，执行时提交该 ID。计划有效期 10 分钟，仅保存在当前进程。执行前检查会话是否变化；操作顺序执行，遇错停止，已完成操作不自动回滚，也不自动重试写入。

会话改名、归档和移动会读回核对。项目改名会保留原说明、图标和颜色，通过项目列表核对名称；目标不在已记录的列表页中时停止。创建项目返回 `verified=false`，需要重新查询项目列表或在网页核对。

## 项目接口校准

项目功能依赖 ChatGPT 内部接口，需要记录对应网页操作。每种操作在首次使用或接口变化后校准一次。

1. 调用 `chatgpt_status`，确认已连接且登录。
2. 调用 `chatgpt_record_start`，填写操作名称和确切示例值。
3. 在工具选中的 ChatGPT 页面示范一次对应操作。创建、改名和移动会实际改变账号数据，请选择确实需要的操作。
4. 调用 `chatgpt_record_finish`。只有一个匹配请求时保存；有多个时选择正确的 `candidate_id` 再调用。传 `cancel=true` 可取消。

| operation | examples | 网页示范 |
| --- | --- | --- |
| `list_projects` | `{}` | 展开项目列表或刷新显示列表的页面 |
| `list_project_conversations` | `{"project_id":"g-p-实际ID"}` | 打开项目，加载会话列表 |
| `create_project` | `{"name":"编程学习"}` | 创建同名项目 |
| `rename_project` | `{"project_id":"g-p-实际ID","name":"编程笔记"}` | 将该项目改为这个名称 |
| `move_conversation` | `{"project_id":"g-p-目标ID","conversation_id":"实际会话ID"}` | 将会话移入目标项目 |

ID 可从页面链接或列表响应读取。示例名称必须与请求发送的名称一致。录制期间固定使用该页面；页面关闭、刷新或连接中断后，应取消并重新开始。

模板保存在数据目录的 `project-routes.json`，格式见[模板示例](../config/project-routes.example.json)。只接受 `chatgpt.com/backend-api/` 下的相关请求，不保存请求头或响应正文；包含令牌、Cookie、密码或非空提示词等字段的请求会被拒绝。匹配使用完整 JSON 值和 URL 段。

扩展模式下，Chrome 请求事件可能缺少 PATCH 正文。录制期间，扩展会临时观察所选页面的 `fetch`，收集相关请求的小型 JSON 正文；结束录制或 10 分钟后恢复，不读取请求头、不修改请求。页面刷新会清除观察器。

列表查询保留后台 `cursor`。`pagination` 只可覆盖模板中已有的 `offset`、`limit`、`cursor`、`after` 参数。单页不代表完整列表，`total_hint` 也不是准确总数。

## 配置与连接

默认独立浏览器模式不需要配对文件或扩展连接端口。可选 `chrome` 模式通过 Chrome 原生授权连接，关闭 ChatGPT 页面后会自动寻找其他已登录页面；录制期间不会换页。

可选 `extension` 模式在页面内请求 ChatGPT，自动配对和选择页面。MCP 同时监听回环地址供扩展连接，无需额外启动服务。一个实例仅连接一个浏览器配置文件，默认端口只能由一个实例监听。

环境变量直接在 MCP 客户端配置中设置，程序不自动读取 `.env`：

| 变量 | 用途 |
| --- | --- |
| `CHATGPT_DATA_DIR` | 自定义数据目录 |
| `CHATGPT_BRIDGE_PORT` | 仅扩展模式：连接端口，默认 `43127`；更改时在扩展高级设置填相同值 |
| `CHATGPT_TRANSPORT` | 默认 `playwright` 独立浏览器，可选 `chrome` 或 `extension` |
| `CHATGPT_BROWSER_CHANNEL` | 独立浏览器使用 `chrome`、`msedge` 或 `chromium`；未设置时自动寻找 |
| `CHATGPT_BROWSER_EXECUTABLE` | 独立浏览器使用的 Chromium 系浏览器可执行文件路径 |

默认数据目录：Windows `%LOCALAPPDATA%/chatgpt-organizer`，macOS `~/Library/Application Support/chatgpt-organizer`，Linux `${XDG_DATA_HOME:-~/.local/share}/chatgpt-organizer`。已有源码安装若在 `.local/` 保存了连接或接口模板，会继续使用该目录。数据位置不依赖 npx 缓存或启动工作目录。

## 数据与限制

- 不需要 `OPENAI_API_KEY`，不调用收费模型 API；分类建议由 MCP 客户端的模型生成。
- 登录令牌在浏览器页面内使用，不通过 MCP 返回；不导出或复制日常浏览器的登录资料。独立浏览器资料保存在数据目录的 `browser/`，包含私密数据，不应提交或分发。
- 可选扩展权限包括 `chatgpt.com`、`127.0.0.1`、扩展存储和请求记录。其连接密钥保存在数据目录的 `bridge-config.json`，不应提交或分发。
- 扩展自动配对限制为 manifest 公钥对应的来源，并检查请求标记；后续请求校验随机密钥及浏览器实例。这不是针对其他高权限扩展或本机进程的身份认证。
- 不处理或绕过验证码。401、403、429 和不确定写入会分别报告。
- 请求仅限 `https://chatgpt.com/backend-api/`，不跟随重定向。日志使用 stderr，stdout 仅传输 MCP。
- 不提供删除、分享和成员管理工具；移入共享项目可能扩大可见范围，执行前核对目标项目。
- 使用账号默认上下文，不支持显式选择工作区或多个账号并行整理。
- 会话正文只返回当前分支文字片段，不是完整导出；项目响应有深度、数量和字符串长度上限。
