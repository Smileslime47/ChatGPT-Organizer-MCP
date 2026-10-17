# ChatGPT Organizer MCP

简体中文 | [English](README.en.md)

让 AI 帮你搜索、重命名、归档 ChatGPT 会话，并整理到项目（Projects）。修改前先生成计划，确认后执行。

使用专用浏览器窗口登录 ChatGPT，之后由 MCP 完成整理。无需手动开启远程调试或单独启动服务。

## 安装

需要 Node.js 22+、支持 stdio MCP 的客户端，以及 Chrome、Edge 或 Chromium。程序会自动寻找可用浏览器。

将 MCP 安装包的绝对路径填入客户端配置：

```json
{
  "mcpServers": {
    "chatgpt-organizer": {
      "command": "npx",
      "args": [
        "--yes",
        "--package=/absolute/path/chatgpt-organizer-mcp-1.0.0.tgz",
        "chatgpt-organizer"
      ]
    }
  }
}
```

从源码生成安装包：

```sh
npm ci
npm run package
```

生成的 MCP 安装包位于 `release/chatgpt-organizer-mcp-1.0.0.tgz`。当前尚未发布到 npm，配置直接使用此文件。

没有可用浏览器时，运行 `npx playwright@1.64.1 install chromium` 安装 Chromium。

## 使用

在 MCP 客户端提出：

> 连接 ChatGPT，列出最近 100 条会话，先给我一份整理计划。

首次使用会打开专用登录窗口。在 ChatGPT 官网选择你的登录方式，登录完成后关闭该窗口，再告诉 AI「继续连接」。之后会复用该专用目录的登录状态；登录失效时按提示重新登录。

登录时浏览器不受 MCP 控制，整理时才连接。日常浏览器无需调整，MCP 由客户端自动启动。

会话查询、搜索、改名和归档可直接使用。项目功能首次使用需要在网页示范一次相应操作，详见[项目接口校准](docs/GUIDE.md#项目接口校准)。

## 说明

本项目使用 ChatGPT 网页内部接口，无需 API Key。接口可能随网页更新变化；暂不支持多账号并行整理，不提供删除功能或远程 MCP URL。

[开发指南](docs/GUIDE.md)包含浏览器配置、工具说明和发布步骤，也提供复用日常 Chrome 登录的可选配置。

## 许可证

[MIT](LICENSE)
