# Connecting the Cashmere MCP server

The server ships in the `@cashmerelabs/cashmere-agent-sdk` npm package and runs over stdio with
`npx -y @cashmerelabs/cashmere-agent-sdk@0.2.0`. It needs Node.js 22 or later. Keep the version pinned: the process
holds the keys.

## Claude Code

Install the plugin, which brings this skill and the server together:

```
/plugin install cashmere --marketplace cashmere-prod/cashmere-agent-sdk
```

On Claude Code before 2.1.275, run `/plugin marketplace add cashmere-prod/cashmere-agent-sdk`, then
`/plugin install cashmere@cashmere`. Claude Code asks for the optional private keys and stores them in the system
keychain. Or add only the server:

```bash
claude mcp add --env CASHMERE_MCP_READ_ONLY=1 --env npm_config_ignore_scripts=true --transport stdio cashmere -- npx -y @cashmerelabs/cashmere-agent-sdk@0.2.0
```

## Claude Desktop

Add the server to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "cashmere": {
      "command": "npx",
      "args": ["-y", "@cashmerelabs/cashmere-agent-sdk@0.2.0"],
      "env": { "CASHMERE_EVM_PRIVATE_KEY": "0x...", "npm_config_ignore_scripts": "true" }
    }
  }
}
```

For quotes only, use `"CASHMERE_MCP_READ_ONLY": "1"` in place of the key. The skill needs this local server, so it works
in Claude Desktop, not in claude.ai in a browser.

## Hermes Agent

Add it under `mcp_servers` in `~/.hermes/config.yaml`. The tools then appear as `mcp_cashmere_cashmere_simulate`
and so on:

```yaml
mcp_servers:
  cashmere:
    command: "npx"
    args: ["-y", "@cashmerelabs/cashmere-agent-sdk@0.2.0"]
    env:
      CASHMERE_EVM_PRIVATE_KEY: "0x..."
      npm_config_ignore_scripts: "true"
```

## Environment

The server reads only `CASHMERE_` names, so a key exported in the shell for other tools never reaches it.

| Variable | Effect |
|---|---|
| `CASHMERE_EVM_PRIVATE_KEY`, `CASHMERE_SOLANA_PRIVATE_KEY`, `CASHMERE_APTOS_PRIVATE_KEY`, `CASHMERE_SUI_PRIVATE_KEY` | Wallets the server sends from. `cashmere_bridge` appears only when at least one is set |
| `CASHMERE_MCP_READ_ONLY=1` | Quotes and routes only. The keys are not read |
| `CASHMERE_MCP_MAX_AMOUNT=500` | Largest USDC amount per transfer |
| `CASHMERE_MCP_MAX_TOTAL=2000` | Largest USDC total while the server runs |
| `CASHMERE_MCP_ALLOWED_RECIPIENTS=0x...,9WzD...` | The only recipients the server sends to, comma-separated |
| `CASHMERE_EVM_RPC_URL`, `CASHMERE_SOLANA_RPC_URL`, `CASHMERE_APTOS_RPC_URL`, `CASHMERE_SUI_RPC_URL` | Custom RPC endpoints, https only (or a local node). The EVM one serves every EVM source chain, so set it only for a single-chain setup. The Sui one is a gRPC endpoint |
| `CASHMERE_GAS_API_URL` | Cashmere Gas API, https only. Default `https://gas.cashmere.exchange` |
| `npm_config_ignore_scripts=true` | `npx` installs without running dependency install scripts, which would otherwise run with the keys in their environment |

Paste each key as the wallet exports it: hex for EVM wallets such as MetaMask; base58 for Phantom or Solflare, or
`solana-keygen`'s JSON array; hex or `ed25519-priv-0x...` for Aptos wallets such as Petra; `suiprivkey1...` for
Slush or Sui Wallet, or hex.

Give the agent a dedicated wallet that holds only what it may spend, plus gas, and set the limits above.
