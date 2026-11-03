<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/emass-wordmark-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/emass-wordmark-light.png">
  <img alt="eMASS — Enterprise Mission Assurance Support Service" src="assets/emass-wordmark-light.png" width="520">
</picture>

<h1>emass-mcp</h1>

<p><strong>A Model Context Protocol server for the eMASS REST API.</strong><br>
All 104 eMASS operations as MCP tools, generated from MITRE's OpenAPI specification.</p>

<p>
  <img alt="MCP server" src="https://img.shields.io/badge/MCP-server-000000">
  <img alt="eMASS API v3.22" src="https://img.shields.io/badge/eMASS%20API-v3.22-1f6feb">
  <img alt="104 operations" src="https://img.shields.io/badge/operations-104-2da44e">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p>
  <a href="#quick-start">Quick start</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#development">Development</a>
</p>

</div>

---

## Overview

`emass-mcp` lets an MCP client such as Claude work directly with eMASS. Its tools come from MITRE's eMASS OpenAPI specification ([mitre/emass_client](https://github.com/mitre/emass_client), API v3.22), which ships with the server in [`spec/`](spec/).

| Area | What's covered |
| --- | --- |
| **Systems** | Systems and system roles |
| **Controls** | Controls and test results |
| **POA&Ms** | POA&Ms and milestones |
| **Artifacts** | Upload from, or export to, local files |
| **Approvals** | PAC/CAC approvals and workflows |
| **Baselines** | Hardware and software baselines |
| **Scans** | Device, cloud, container and static-code scan results |
| **CMMC** | CMMC assessments |
| **Dashboards** | Every dashboard. The ~60 dashboards share one tool, `emass_get_dashboard`, so they don't flood the client's tool list. |

> [!NOTE]
> Write tools (POST, PUT, DELETE) appear only when `EMASS_USER_UID` is set. Without it the server is read-only.

## Quick start

**1. Build the server**

```sh
pnpm install
pnpm build
```

**2. Add it to your MCP client.** The server talks over stdio.

```json
{
  "mcpServers": {
    "emass": {
      "command": "node",
      "args": ["/path/to/emass-mcp/dist/index.js"],
      "env": {
        "EMASS_URL": "https://emass.example.mil",
        "EMASS_API_KEY": "…",
        "EMASS_USER_UID": "1234567890",
        "EMASS_CERT": "/path/to/client.pem",
        "EMASS_KEY": "/path/to/client.key",
        "EMASS_KEY_PASSPHRASE": "…",
        "EMASS_CA": "/path/to/dod-roots.pem"
      }
    }
  }
}
```

> [!TIP]
> **No eMASS account?** Point the server at MITRE's hosted mock:
> `EMASS_URL=https://stoplight.io/mocks/mitre/emasser/32836028`. Any API key and user-uid work there.

## Configuration

| Variable | Required | Description |
| --- | :---: | --- |
| `EMASS_URL` | ✅ | The eMASS API host. |
| `EMASS_API_KEY` | ✅ | Sent as the `api-key` header on every call. |
| `EMASS_USER_UID` | for writes | Sent as the `user-uid` header. For DoD users this is the EDIPI on their CAC. eMASS refuses POST, PUT and DELETE without it, so the server offers only read tools until it is set. |
| `EMASS_CERT`, `EMASS_KEY` | for mTLS | PEM client certificate and key, as a file path or the PEM text. eMASS requires mutual TLS. |
| `EMASS_KEY_PASSPHRASE` | if key is encrypted | Passphrase for `EMASS_KEY`. |
| `EMASS_CA` | if needed | A PEM CA bundle, for hosts that chain to roots Node doesn't trust, such as the DoD roots. |
| `EMASS_DOWNLOAD_DIR` | — | Where exported artifact files are saved. Defaults to `$TMPDIR/emass-mcp`. A call can name its own location with `saveTo`. |
| `EMASS_TIMEOUT_MS` | — | Request timeout in milliseconds. Defaults to `120000`. |

## Tools

Each operation becomes a tool named `emass_<operationId in snake_case>`:

```text
emass_get_systems
emass_get_system_poams
emass_add_poam_by_system_id
emass_delete_milestone
```

Tool arguments are built from the operation's definition in the spec:

| Input | Becomes |
| --- | --- |
| Path and query parameters | Top-level arguments |
| JSON request bodies | A `body` argument |
| Multipart uploads | The path of a local file (for example, `filename` on `emass_add_artifacts_by_system_id`) |

Each tool's annotations say whether it only reads, can overwrite or delete, and touches an outside system. eMASS errors come back as tool errors, carrying eMASS's own error message.

## Development

```sh
pnpm test        # spec coverage, requests against a local fake eMASS, mutual TLS with generated certificates
pnpm typecheck
```

## License

`emass-mcp` is released under the [MIT License](LICENSE).

The eMASS specification is © The MITRE Corporation, licensed under Apache 2.0. See [`spec/EMASS_CLIENT_NOTICE.md`](spec/EMASS_CLIENT_NOTICE.md).

<sub>emass-mcp is an independent project and is not affiliated with or endorsed by DISA or the U.S. Department of Defense. The eMASS name and wordmark belong to their respective owners.</sub>
