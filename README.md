# emass-mcp

An MCP server for the eMASS REST API (Enterprise Mission Assurance Support Service). Its tools come from MITRE's eMASS OpenAPI specification ([mitre/emass_client](https://github.com/mitre/emass_client), API v3.22). The specification ships with the server in `spec/`.

It covers all 104 eMASS operations:

- systems and system roles
- controls and test results
- POA&Ms and milestones
- artifacts, uploaded from or exported to local files
- PAC/CAC approvals
- hardware and software baselines
- device, cloud, container and static-code scan results
- workflows
- CMMC assessments
- every dashboard. The ~60 dashboards share one tool, `emass_get_dashboard`, so they don't flood the client's tool list.

## Setup

```sh
pnpm install
pnpm build
```

The server talks over stdio.

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

| Variable | Required | Meaning |
| --- | --- | --- |
| `EMASS_URL` | yes | The eMASS API host. |
| `EMASS_API_KEY` | yes | Sent as the `api-key` header on every call. |
| `EMASS_USER_UID` | for writes | Sent as the `user-uid` header. For DoD users this is the EDIPI on their CAC. eMASS refuses POST, PUT and DELETE without it, so the server offers only read tools until it is set. |
| `EMASS_CERT`, `EMASS_KEY` | for mTLS | PEM client certificate and key. Give either a file path or the PEM text. eMASS requires mutual TLS. |
| `EMASS_KEY_PASSPHRASE` | if the key is encrypted | |
| `EMASS_CA` | if needed | A PEM CA bundle, when the host chains to roots Node doesn't trust, such as the DoD roots. |
| `EMASS_DOWNLOAD_DIR` | no | Where exported artifact files are saved. The default is `$TMPDIR/emass-mcp`. A call can name its own location with `saveTo`. |
| `EMASS_TIMEOUT_MS` | no | Request timeout. The default is 120000. |

To try it without an eMASS account, use MITRE's hosted mock: set `EMASS_URL=https://stoplight.io/mocks/mitre/emasser/32836028`. Any API key and user-uid work there.

## Tools

Each operation becomes a tool named `emass_<operationId in snake_case>`, for example `emass_get_systems`, `emass_get_system_poams`, `emass_add_poam_by_system_id` and `emass_delete_milestone`.

Tool arguments are built from the operation's definition in the spec:

- **Parameters:** path and query parameters become top-level arguments.
- **JSON bodies:** passed as `body`.
- **Multipart uploads:** take the path of a local file (for example, `filename` on `emass_add_artifacts_by_system_id`).

Each tool's annotations say whether it only reads, can overwrite or delete, and touches an outside system.

eMASS errors come back as tool errors, with eMASS's own error message.

## Development

```sh
pnpm test        # spec coverage, requests against a local fake eMASS, mutual TLS with generated certificates
pnpm typecheck
```

The eMASS specification is © The MITRE Corporation, licensed under Apache 2.0. See `spec/EMASS_CLIENT_NOTICE.md`.
