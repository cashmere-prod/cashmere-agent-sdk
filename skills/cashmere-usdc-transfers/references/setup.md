# Connecting the Cashmere MCP server

The server ships in the `@cashmerelabs/cashmere-agent-sdk` npm package and runs over stdio with
`npx -y @cashmerelabs/cashmere-agent-sdk`. It needs Node.js 20.19 or later (22+ recommended).

## Claude Code

Install the plugin, which brings this skill and the server together:

```
/plugin install cashmere --marketplace cashmere-prod/cashmere-agent-sdk
```

On Claude Code before 2.1.275, run `/plugin marketplace add cashmere-prod/cashmere-agent-sdk`, then
`/plugin install cashmere@cashmere`. Claude Code asks for the optional private keys and stores them in the system
keychain. Or add only the server:

```bash
claude mcp add --env CASHMERE_MCP_READ_ONLY=1 --transport stdio cashmere -- npx -y @cashmerelabs/cashmere-agent-sdk
```

## Claude Desktop

Add the server to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "cashmere": {
      "command": "npx",
      "args": ["-y", "@cashmerelabs/cashmere-agent-sdk"],
      "env": { "EVM_PRIVATE_KEY": "0x..." }
    }
  }
}
```

For quotes only, use `"env": { "CASHMERE_MCP_READ_ONLY": "1" }` instead. The skill needs this local server, so it works
in Claude Desktop, not in claude.ai in a browser.

## Hermes Agent

Add it under `mcp_servers` in `~/.hermes/config.yaml`. The tools then appear as `mcp_cashmere_cashmere_simulate`
and so on:

```yaml
mcp_servers:
  cashmere:
    command: "npx"
    args: ["-y", "@cashmerelabs/cashmere-agent-sdk"]
    env:
      EVM_PRIVATE_KEY: "0x..."
```

## Environment

| Variable | Effect |
|---|---|
| `EVM_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`, `APTOS_PRIVATE_KEY`, `SUI_PRIVATE_KEY` | Wallets the server sends from. `cashmere_bridge` appears only when at least one is set |
| `CASHMERE_MCP_READ_ONLY=1` | Quotes and routes only. The keys are not read |
| `CASHMERE_MCP_MAX_AMOUNT=500` | Largest USDC amount per transfer |
| `EVM_RPC_URL`, `SOLANA_RPC_URL`, `APTOS_RPC_URL`, `SUI_RPC_URL` | Custom RPC endpoints. `EVM_RPC_URL` serves every EVM source chain, so set it only for a single-chain setup. `SUI_RPC_URL` is a gRPC endpoint |
| `GAS_API_URL` | Cashmere Gas API, default `https://gas.cashmere.exchange` |

Give the agent a dedicated wallet that holds only what it may spend, plus gas.
