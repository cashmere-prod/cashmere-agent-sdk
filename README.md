# @cashmerelabs/cashmere-agent-sdk

TypeScript SDK for Cashmere CCTP cross-chain USDC transfers across EVM, Solana, Aptos, and Sui.

## Install

```bash
npm install @cashmerelabs/cashmere-agent-sdk
```

Requires Node.js 22 or later: the Sui client is an ES module that the CommonJS build loads with `require()`, and
its dependencies need Node 22. Sui fullnodes no longer serve JSON-RPC, so the Sui `rpcUrl` is a gRPC endpoint (default
`https://fullnode.mainnet.sui.io:443`).

## AI Agent / OpenClaw Integration

To give Claude Desktop, Claude Code, Hermes Agent or any other MCP client the transfer tools directly, run the
bundled [MCP server](#mcp-server) and add the [agent skill](#agent-skill) for payments and transfers.

Two files are written for agents, and both ship in the npm package:

- [`skills/cashmere-usdc-transfers/SKILL.md`](skills/cashmere-usdc-transfers/SKILL.md) is the [agent skill](#agent-skill)
  for sending payments and transfers with the MCP tools.
- `SKILL.md` at the package root is a developer reference for building transactions against the Cashmere contracts
  directly: addresses, ABIs, the Gas API and the routing rules. It is not an Agent Skills skill. Agents (Cursor, Codex,
  OpenClaw, LangChain, etc.) can read it at `node_modules/@cashmerelabs/cashmere-agent-sdk/SKILL.md`.

For OpenClaw-based agents, register the SDK as a tool:

```typescript
// OpenClaw tool registration example
import { CashmereCCTP } from '@cashmerelabs/cashmere-agent-sdk';
import { readFileSync } from 'fs';

const skillContext = readFileSync(
  require.resolve('@cashmerelabs/cashmere-agent-sdk/SKILL.md'), 'utf-8'
);

const cctp = new CashmereCCTP({
  evm: { privateKey: process.env.EVM_PRIVATE_KEY! },
  solana: { privateKey: process.env.SOLANA_PRIVATE_KEY! },
});

// Expose cctp.transfer() as an agent tool with SKILL.md as context, behind a step where the user confirms each transfer
```

The SKILL.md provides:
- All supported chains, domain IDs, and contract addresses
- CCTP V2 routing rules and fee structures (V1 is legacy: the SDK sends every route over V2)
- Per-chain transfer patterns (EVM, Solana, Aptos, Sui)
- Gas API integration details

## Quick Start

```typescript
import { CashmereCCTP } from '@cashmerelabs/cashmere-agent-sdk';

const cctp = new CashmereCCTP({
  evm: { privateKey: process.env.EVM_PRIVATE_KEY! },
  solana: { privateKey: process.env.SOLANA_PRIVATE_KEY! },
  aptos: { privateKey: process.env.APTOS_PRIVATE_KEY! },
  sui: { privateKey: process.env.SUI_PRIVATE_KEY! },
});

// Ethereum -> Arbitrum, 100 USDC, V2 Fast
const result = await cctp.transfer({
  from: 'ethereum',
  to: 'arbitrum',
  amount: '100',
  recipient: '0xYourArbitrumAddress',
  version: 'v2-fast',
  feeMode: 'native',
});

console.log(result.txHash);
console.log(result.explorerUrl);
```

The SDK reads no files: pass the keys from your environment, for example from a `.env` made from `.env.example` and
loaded with `node --env-file=.env app.js`.

## Configuration

Only configure the chains you need:

```typescript
// EVM-only bot
const cctp = new CashmereCCTP({
  evm: { privateKey: process.env.EVM_PRIVATE_KEY! },
});

// With custom RPC
const cctp = new CashmereCCTP({
  evm: {
    privateKey: process.env.EVM_PRIVATE_KEY!,
    rpcUrl: 'https://my-rpc.example.com',
  },
  solana: {
    privateKey: process.env.SOLANA_PRIVATE_KEY!,
    rpcUrl: 'https://my-solana-rpc.example.com',
  },
});

// Custom Gas API URL
const cctp = new CashmereCCTP({
  evm: { privateKey: process.env.EVM_PRIVATE_KEY! },
  gasApiUrl: 'https://gas.cashmere.exchange',
});
```

## Transfer Parameters

```typescript
await cctp.transfer({
  from: 'ethereum',        // source chain
  to: 'arbitrum',          // destination chain
  amount: '100',           // USDC amount (human-readable, 6 decimals applied automatically)
  recipient: '0x...',      // destination address in the destination chain's format (checked before signing)
  version: 'v2-fast',      // optional: 'v2-fast' | 'v2-norm' (auto-resolved if omitted; 'v1' is sent over V2)
  feeMode: 'native',       // optional: 'native' | 'stable' (default: 'native')
});
```

### Version Auto-Resolution

If `version` is omitted, the SDK picks V2 Fast where the route supports it and V2 Norm otherwise. Every route has
CCTP V2, Aptos and Sui included, so the SDK does not use V1: Circle is retiring V1 burns, and a requested `v1`
falls back to V2 the same way an unsupported `v2-fast` falls back to `v2-norm`.

### Solana Recipients

For Solana destinations, pass the wallet address (not the ATA). The SDK computes the USDC ATA automatically:

```typescript
await cctp.transfer({
  from: 'ethereum',
  to: 'solana',
  amount: '50',
  recipient: 'SolanaWalletPublicKeyBase58',
});
```

## Supported Routes

| Source          | V1 | V2 Fast | V2 Norm | Destinations                    |
|-----------------|----|---------|---------|---------------------------------|
| Ethereum        | Y  | Y       | Y       | All EVM, Solana, Aptos, Sui     |
| Arbitrum        | Y  | Y       | Y       | All EVM, Solana, Aptos, Sui     |
| Base            | Y  | Y       | Y       | All EVM, Solana, Aptos, Sui     |
| Optimism        | Y  | Y       | Y       | All EVM, Solana, Aptos, Sui     |
| Unichain        | Y  | Y       | Y       | All EVM, Solana, Aptos, Sui     |
| Polygon         | Y  | N       | Y       | All EVM, Solana, Aptos, Sui     |
| Avalanche       | Y  | N       | Y       | All EVM, Solana, Aptos, Sui     |
| Linea           | N  | Y       | Y       | All EVM, Solana, Aptos, Sui     |
| Worldchain      | N  | Y       | Y       | All EVM, Solana, Aptos, Sui     |
| Sei             | N  | N       | Y       | All EVM, Solana, Aptos, Sui     |
| Sonic           | N  | N       | Y       | All EVM, Solana, Aptos, Sui     |
| HyperEVM        | N  | N       | Y       | All EVM, Solana, Aptos, Sui     |
| Monad           | N  | N       | Y       | All EVM, Solana, Aptos, Sui     |
| Arc             | N  | N       | Y       | All EVM, Solana, Aptos, Sui     |
| Solana          | Y  | N       | Y       | All EVM, Aptos, Sui             |
| Aptos           | Y  | N       | Y       | All EVM, Solana, Sui            |
| Sui             | Y  | N       | Y       | All EVM, Solana, Aptos          |

V1 shows what the contracts still accept; the SDK sends every route over V2. Circle quotes no Fast fee from Arc, Aptos
or Sui, so transfers from them go V2 Norm; transfers to them go V2 Fast where the source has it.

## Utilities

```typescript
import {
  CCTP_DOMAINS,
  USDC_ADDRESSES,
  isV1Supported,
  isV2FastSupported,
  resolveVersion,
  GasApiClient,
} from '@cashmerelabs/cashmere-agent-sdk';

// Check route support
isV1Supported('ethereum', 'arbitrum');     // true
isV2FastSupported('polygon', 'base');      // false (polygon = V2 Norm only)

// Resolve best version
resolveVersion('ethereum', 'arbitrum');    // 'v2-fast'
resolveVersion('aptos', 'sui');            // 'v2-norm' (Circle quotes no V2 Fast from Aptos)

// Direct Gas API access
const gas = new GasApiClient();
const sig = await gas.getEcdsaSignature(0, 3, true, false);
```

## Simulate (Preview Before Execute)

```typescript
const sim = await cctp.simulate({
  from: 'ethereum',
  to: 'arbitrum',
  amount: '100',
});

console.log(sim.supported);         // true
console.log(sim.version);           // 'v2-fast'
console.log(sim.estimatedDuration); // '~15 seconds'
console.log(sim.estimatedFee);      // { cashmere: '343617201738094 wei (native)', circleBurnBps: 1.3 }

if (sim.supported) {
  await cctp.transfer({ from: 'ethereum', to: 'arbitrum', amount: '100', recipient: '0x...' });
}
```

`estimatedFee.cashmere` is Cashmere's fixed fee. With `feeMode: 'native'` (the default) it is in the source chain's
smallest native unit (wei on EVM chains, lamports, octas, MIST); with `'stable'` it reads like `'0.19 USDC'` and comes out
of the amount. On top of it, Cashmere takes an on-chain percentage of the amount (at most 1%, not in the quote), and on
V2 Fast Circle keeps up to `circleBurnBps` basis points when it mints. So the recipient gets slightly less than `amount`.

Arc's gas token is USDC itself, with 18 decimals: a native fee from Arc of `'190000000000000000 wei (native)'` is
0.19 USDC, and the one USDC balance there pays the amount, the fee and the gas.

## MCP Server

The package includes an MCP server, so Claude Desktop, Claude Code, Hermes Agent and other MCP clients can quote and
send transfers as tools. It runs over stdio and needs Node.js 22 or later:

```bash
npx -y @cashmerelabs/cashmere-agent-sdk@0.2.0
```

Pin the version as here: the process holds your keys, so it should run exactly the release you chose.

| Tool | What it does |
|------|--------------|
| `cashmere_supported_routes` | Routes, CCTP versions, default version and durations, optionally filtered by `from` and `to`. Read-only |
| `cashmere_simulate` | Fee, version and duration of a transfer, from the live Gas API and Circle Iris. Read-only |
| `cashmere_bridge` | Sends the transfer and returns its hash and explorer link |

`cashmere_bridge` moves funds, so:

- It is listed only when a private key is set and `CASHMERE_MCP_READ_ONLY` is not.
- Its description tells the agent to confirm the amount, the chains and the recipient with the user before calling it,
  and not to retry a failed call on its own.
- It is annotated as destructive. In Claude Code it always needs the user's own approval, never a one-tap one.
- Before signing, it refuses:
  - a recipient that is not in the destination chain's address format, which CCTP would otherwise mint to as an account
    nobody controls;
  - a Gas API quote for another destination, or with a fee or deadline out of bounds;
  - an amount above `CASHMERE_MCP_MAX_AMOUNT` or past `CASHMERE_MCP_MAX_TOTAL`, or a recipient outside
    `CASHMERE_MCP_ALLOWED_RECIPIENTS`;
  - a transfer identical to one from the last 10 minutes, unless the agent passes `allowDuplicate` after asking the user;
  - a call that the client cancelled or timed out while it waited.
- It sends one transfer at a time and reports success only once the transaction is confirmed. Its errors never contain
  a private key.

### Environment

The server reads its settings from the environment only, and only under `CASHMERE_` names. Claude Code passes your
shell environment to MCP servers, so a key exported there for other tools, such as an `EVM_PRIVATE_KEY`, never becomes a
wallet the agent can spend from.

| Variable | Effect |
|----------|--------|
| `CASHMERE_EVM_PRIVATE_KEY`, `CASHMERE_SOLANA_PRIVATE_KEY`, `CASHMERE_APTOS_PRIVATE_KEY`, `CASHMERE_SUI_PRIVATE_KEY` | Wallets `cashmere_bridge` sends from. Set only the chains you need |
| `CASHMERE_MCP_READ_ONLY=1` | Simulate and routes only: `cashmere_bridge` is off and the keys are not read |
| `CASHMERE_MCP_MAX_AMOUNT=500` | Largest USDC amount per transfer |
| `CASHMERE_MCP_MAX_TOTAL=2000` | Largest USDC total while the server runs |
| `CASHMERE_MCP_ALLOWED_RECIPIENTS=0x...,9WzD...` | The only recipients `cashmere_bridge` sends to, comma-separated |
| `CASHMERE_EVM_RPC_URL`, `CASHMERE_SOLANA_RPC_URL`, `CASHMERE_APTOS_RPC_URL`, `CASHMERE_SUI_RPC_URL` | Custom RPCs, https only (or a local node). The EVM one serves every EVM source chain, so set it only for a single-chain setup. The Sui one is a gRPC endpoint |
| `CASHMERE_GAS_API_URL` | Gas API, https only. Default `https://gas.cashmere.exchange` |
| `npm_config_ignore_scripts=true` | Set it in the same `env`: `npx` then installs without running dependency install scripts, which would otherwise run with your keys in their environment |

Paste each key as the wallet exports it: hex for EVM wallets such as MetaMask; base58 for Phantom or Solflare, or
`solana-keygen`'s JSON array; hex or `ed25519-priv-0x...` for Aptos wallets such as Petra; `suiprivkey1...` for
Slush or Sui Wallet, or hex.

Give the agent a dedicated wallet that holds only what it may spend, plus gas, and set the limits above.

### Claude Desktop

Add the server to `claude_desktop_config.json` (Settings → Developer → Edit Config: `~/Library/Application Support/Claude/`
on macOS, `%APPDATA%\Claude\` on Windows) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "cashmere": {
      "command": "npx",
      "args": ["-y", "@cashmerelabs/cashmere-agent-sdk@0.2.0"],
      "env": {
        "CASHMERE_EVM_PRIVATE_KEY": "0x...",
        "CASHMERE_MCP_MAX_AMOUNT": "500",
        "npm_config_ignore_scripts": "true"
      }
    }
  }
}
```

For quotes only, replace the key with `"CASHMERE_MCP_READ_ONLY": "1"`. Claude Desktop starts `npx` from your `PATH`, which
needs Node.js 22 or later.

### Claude Code

This repository is also a Claude Code plugin marketplace. The `cashmere` plugin brings the MCP server and the
[agent skill](#agent-skill) together, and asks for the optional keys, which it keeps in the system keychain:

```bash
/plugin install cashmere --marketplace cashmere-prod/cashmere-agent-sdk
```

On Claude Code before 2.1.275, run `/plugin marketplace add cashmere-prod/cashmere-agent-sdk`, then
`/plugin install cashmere@cashmere`. To add only the server:

```bash
claude mcp add --env CASHMERE_MCP_READ_ONLY=1 --env npm_config_ignore_scripts=true --transport stdio cashmere -- npx -y @cashmerelabs/cashmere-agent-sdk@0.2.0
```

### Hermes Agent

Add the server under `mcp_servers` in `~/.hermes/config.yaml`. Hermes passes a stdio server the `env` listed here plus
a small safe baseline, not your shell environment, and names the tools `mcp_cashmere_cashmere_simulate` and so on:

```yaml
mcp_servers:
  cashmere:
    command: "npx"
    args: ["-y", "@cashmerelabs/cashmere-agent-sdk@0.2.0"]
    env:
      CASHMERE_EVM_PRIVATE_KEY: "0x..."
      CASHMERE_MCP_MAX_AMOUNT: "500"
      npm_config_ignore_scripts: "true"
```

### From a clone

Run `npm install && npm run build`, then point the client at the built file instead of `npx`:
`"command": "node", "args": ["/path/to/cashmere-agent-sdk/dist/mcp/cli.js"]`.

## Agent Skill

[`skills/cashmere-usdc-transfers`](skills/cashmere-usdc-transfers/SKILL.md) teaches an agent to run USDC payments and
transfers with the MCP tools. The agent collects the amount, the chains and the recipient, checks the address format,
quotes the transfer and confirms it with the user. Only then does it send, and it reports the result. The skill also
covers fees, speed and failures. It follows the [Agent Skills](https://agentskills.io) format, so any agent that reads
skills can use it:

| Agent | Install |
|-------|---------|
| Claude Code | The `cashmere` plugin above includes it |
| Claude Desktop | Zip the `skills/cashmere-usdc-transfers` folder and upload it with **Upload skill** under Customize → Skills (code execution must be on). The skill drives the local MCP server, so use it in Claude Desktop, not claude.ai in a browser |
| Hermes Agent | `hermes skills install cashmere-prod/cashmere-agent-sdk/skills/cashmere-usdc-transfers` |
| Others | Copy the folder into the agent's skills directory, such as `~/.claude/skills/`. It also ships in the npm package |

## Agent Framework Integration

### OpenAI Assistants / Function Calling

```typescript
import { bridgeToolSchema, simulateToolSchema, supportedRoutesToolSchema } from '@cashmerelabs/cashmere-agent-sdk';

const tools = [
  { type: "function", function: bridgeToolSchema },
  { type: "function", function: simulateToolSchema },
  { type: "function", function: supportedRoutesToolSchema },
];

// Pass to OpenAI chat completion
const response = await openai.chat.completions.create({
  model: "gpt-4",
  messages: [...],
  tools,
});
```

### LangChain

```bash
npm install @langchain/core @langchain/langgraph @langchain/anthropic
```

```typescript
import { CashmereCCTP } from '@cashmerelabs/cashmere-agent-sdk';
import { CashmereBridgeTool, CashmereSimulateTool } from '@cashmerelabs/cashmere-agent-sdk/tools/langchain';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatAnthropic } from '@langchain/anthropic';

const cctp = new CashmereCCTP({ evm: { privateKey: process.env.EVM_PRIVATE_KEY! } });
const tools = [
  new CashmereBridgeTool(cctp),
  new CashmereSimulateTool(cctp),
];

// Any LangChain chat model works
const agent = createReactAgent({ llm: new ChatAnthropic({ model: 'claude-sonnet-5-5' }), tools });
```

`CashmereBridgeTool` sends as soon as the agent calls it. Its description tells the model to confirm with the user
first, but put a human approval step in front of it too (LangGraph supports interrupts), or give the agent only
`CashmereSimulateTool`.

### crewAI

crewAI is a Python framework, so the TypeScript classes above don't apply. Connect it to the [MCP server](#mcp-server)
through crewAI's MCP support, or define its tools from the JSON schemas (`bridgeToolSchema`, `simulateToolSchema`,
`supportedRoutesToolSchema`).

### Hermes (Nous Research)

Hermes models take tools as OpenAI-style functions inside `<tools>` in the system prompt and answer with
`<tool_call>{"name": ..., "arguments": ...}</tool_call>` blocks. Behind an OpenAI-compatible server with a Hermes tool
parser (vLLM `--enable-auto-tool-choice --tool-call-parser hermes`, SGLang, llama.cpp, Ollama), pass `hermesTools()` as
`tools`, read `tool_calls` as with OpenAI, and send each result back as a `tool` message with its `tool_call_id`.
Hermes Agent can use the [MCP server](#mcp-server) instead. To prompt a Hermes model directly, without a chat template:

```typescript
import {
  CashmereCCTP, getSupportedRoutes, hermesTools, hermesSystemPrompt, parseHermesToolCalls, hermesToolResponse,
} from '@cashmerelabs/cashmere-agent-sdk';

const cctp = new CashmereCCTP({ evm: { privateKey: process.env.EVM_PRIVATE_KEY! } });
const system = hermesSystemPrompt(hermesTools(), 'You move USDC between chains for the user.');
// Hermes 2 Pro and 3 read tool results as a `tool` message, Hermes 4 as a `user` message
const toolResultRole = 'user'; // Hermes 4

// After each model reply. Tool calls inside <think> are skipped.
for (const call of parseHermesToolCalls(reply)) {
  const args = call.arguments as any;
  let result: unknown;
  if (call.name === 'cashmere_simulate') result = await cctp.simulate(args);
  else if (call.name === 'cashmere_supported_routes') result = getSupportedRoutes(args);
  else if (call.name === 'cashmere_bridge') result = await confirmWithUserThenTransfer(args); // your own approval step
  messages.push({ role: toolResultRole, content: hermesToolResponse(call.name, result) });
}
```

`hermesTools({ readOnly: true })` leaves `cashmere_bridge` out. `recipientError(to, recipient)` runs the same address
check as the MCP server.

## How It Works

1. SDK builds and signs a source-chain transaction (burn USDC via Cashmere wrapper)
2. Cashmere's own relayers automatically detect the burn, fetch Circle attestation, and mint USDC on the destination chain
3. No further action needed -- the destination transfer completes automatically

## Security

- Private keys are only used in-memory for transaction signing
- Never stored, logged, or transmitted anywhere except to the chain RPC
- The Gas API (`gas.cashmere.exchange`) only receives domain/fee parameters, never keys
- The MCP server reads keys from its environment only, never logs them, and redacts them from tool errors
- All contract addresses are public on-chain data

## Build

```bash
npm run build
```
