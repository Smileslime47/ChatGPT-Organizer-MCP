# ChatGPT Organizer MCP

[简体中文](README.md) · English

Let AI search, rename, and archive your ChatGPT conversations, and organize them into Projects. Preview changes before confirming and executing them.

Sign in to ChatGPT in a dedicated browser window, then let the MCP server handle organization. No manual remote debugging setup or separate service is required.

## Installation

Requires Node.js 22+, an MCP client that supports stdio, and Chrome, Edge, or Chromium. The server automatically detects an available browser. Firefox and Safari are not currently supported.

Add the absolute path to the MCP package to your client configuration:

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

To build the package from source:

```sh
npm ci
npm run package
```

The MCP package is generated at `release/chatgpt-organizer-mcp-1.0.0.tgz`. It is not yet published to npm; use this file directly in your configuration.

If no compatible browser is installed, run `npx playwright@1.64.1 install chromium` to install Chromium.

## Usage

Ask your MCP client:

> Connect to ChatGPT, list my 100 most recent conversations, and propose an organization plan first.

On first use, a dedicated sign-in window opens. Choose your sign-in method on the official ChatGPT website. After signing in, close that window and ask the AI to continue connecting. Subsequent connections reuse the dedicated browser profile; follow the prompts to sign in again when your session expires.

The browser is not controlled by the MCP server during sign-in. The server connects when you start organizing. Your everyday browser needs no configuration changes, and the MCP client starts the server automatically.

Conversation listing, search, renaming, and archiving are ready to use. Project features require demonstrating each corresponding operation on the website once. See [project API calibration](docs/GUIDE.md#项目接口校准) in the Chinese guide.

## Notes

This project uses ChatGPT's internal web APIs and requires no API key. These APIs may change as the website evolves. Concurrent use of multiple accounts, deletion tools, and a remote MCP URL are not supported.

The [development guide](docs/GUIDE.md) (Chinese) covers browser configuration, tools, and packaging, including the optional mode for connecting to your everyday Chrome session.

## License

[MIT](LICENSE)
