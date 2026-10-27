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
bundled [MCP server](#mcp-server) and add the [agent skills](#agent-skill) for payments, transfers and Goat LP.

Three files are written for agents, and all ship in the npm package:

- [`skills/cashmere-usdc-transfers/SKILL.md`](skills/cashmere-usdc-transfers/SKILL.md) is the [agent skill](#agent-skill)
  for sending payments and transfers with the MCP tools.
- [`skills/goat-lp/SKILL.md`](skills/goat-lp/SKILL.md) is the agent skill for Goat LP pools, positions and automations.
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
npx -y @cashmerelabs/cashmere-agent-sdk@0.4.0
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
| `CASHMERE_EVM_PRIVATE_KEY`, `CASHMERE_SOLANA_PRIVATE_KEY`, `CASHMERE_APTOS_PRIVATE_KEY`, `CASHMERE_SUI_PRIVATE_KEY` | Wallets `cashmere_bridge` sends from. The EVM one is also the wallet of the Goat LP write tools. Set only the chains you need |
| `CASHMERE_MCP_READ_ONLY=1` | Read tools only: `cashmere_bridge` and the Goat LP write tools are off, and the keys are not read |
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
      "args": ["-y", "@cashmerelabs/cashmere-agent-sdk@0.4.0"],
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
claude mcp add --env CASHMERE_MCP_READ_ONLY=1 --env npm_config_ignore_scripts=true --transport stdio cashmere -- npx -y @cashmerelabs/cashmere-agent-sdk@0.4.0
```

### Hermes Agent

Add the server under `mcp_servers` in `~/.hermes/config.yaml`. Hermes passes a stdio server the `env` listed here plus
a small fixed baseline, not your shell environment, and names the tools `mcp_cashmere_cashmere_simulate` and so on:

```yaml
mcp_servers:
  cashmere:
    command: "npx"
    args: ["-y", "@cashmerelabs/cashmere-agent-sdk@0.4.0"]
    env:
      CASHMERE_EVM_PRIVATE_KEY: "0x..."
      CASHMERE_MCP_MAX_AMOUNT: "500"
      npm_config_ignore_scripts: "true"
```

### From a clone

Run `npm install && npm run build`, then point the client at the built file instead of `npx`:
`"command": "node", "args": ["/path/to/cashmere-agent-sdk/dist/mcp/cli.js"]`.

## Goat LP tools (Robinhood Chain)

> Goat LP is experimental. Use small amounts.

The MCP server also has tools for [Goat LP](https://docs.cashmere.exchange/goat-lp/overview), Uniswap v3 and v4
liquidity on Robinhood Chain (chain 4663): pools, positions, adding liquidity, and the auto-compound, auto-range and
auto-exit automations. They are in 0.4.0 and later.

| Tool | What it does |
|------|--------------|
| `goatlp_pools` | Pools with APR, fee APR, TVL, 24 h volume, fee tier and venue, and which automations each pool offers. Read-only |
| `goatlp_pool` | One pool: the price both ways, ranges with their ticks, the APR breakdown, its hook, and why an automation is or is not offered. Read-only |
| `goatlp_positions` | An owner's positions (default: the configured wallet) with value, uncollected fees, APR and PnL, and each automation's state. Read-only |
| `goatlp_position` | One position with its cash flows, its permission and every automation rule, read on chain. Read-only |
| `goatlp_add_liquidity` | Opens a v3 or v4 position, or adds to one the wallet owns, with the token amounts as given and no swap |
| `goatlp_set_auto_compound`, `goatlp_set_auto_range`, `goatlp_set_auto_exit` | Turns an automation on, or changes it, for one position the wallet owns |
| `goatlp_stop_automation` | Stops an automation as the Goat LP app does, and cancels its unused signed messages |

The read tools are always on. The write tools are listed only when `CASHMERE_EVM_PRIVATE_KEY` is set and
`CASHMERE_MCP_READ_ONLY` is not. They are annotated as destructive, so Claude Code always asks for the user's own
approval, and they share `cashmere_bridge`'s queue: one write at a time from the wallet.

### Plan, then execute

Called without `execute`, a write tool sends nothing. It returns a plan and a `planId`: every transaction and signed
message in order, with contract names and addresses, amounts or settings, fees, and the result of simulating it. The
server instructions tell the agent to show the plan to the user and to wait for an explicit yes. Only then does it
call the same tool with the same inputs plus `execute: true` and the `planId`. A plan is single use and lasts 10
minutes. At execute the tool builds the plan again from fresh chain reads and sends nothing if it has changed.

A deposit whose pool price is more than 1% from Chainlink lists `acknowledge` lines, as the app's checkboxes do.
Execute refuses that plan. The agent shows the lines with the plan and, after the user's yes, plans again with
`acknowledge: true` and executes that plan: `acknowledge` is one of the inputs a plan is bound to.

### What the tools check

- The RPC is on Robinhood Chain (4663), checked again before anything is signed.
- Every contract the tools send to, or give a permission to, matches the code hash pinned in this package. None of the
  Goat LP contracts is upgradeable, and their source is published on the explorer ([robin.etherscan.io](https://robin.etherscan.io)).
- The Uniswap v4 position manager's pool manager and the v3 position manager's factory are the pinned addresses, read
  once per server. Otherwise every write refuses.
- Each transaction is decoded and simulated (`eth_call`) right before it is signed. A revert refuses it.
- A signed message (v4 auto-compound) is decoded and checked before signing: only a `Permit` for `GoatAutoCompoundV4`,
  for a position the wallet owns, within the app's run and deadline limits.
- Never a permission for all positions, never an unlimited token or Permit2 allowance, never a transfer of a position,
  never an output to anyone but the wallet, and never an owner, guardian or keeper function. Another app's approval is
  left alone.
- Automations only where the app offers them: the pair registry and pair table, the reviewed hooks with their pinned
  code hashes, and the keeper's size limit per pair. A refusal gives the app's reason. Nothing is turned on while the
  automation policy at `api.cashmere.exchange` cannot be read; a stop still works.
- Deposits: pools of the Uniswap v3 factory, or v4 pools without a hook; no token that copies an official stock ticker
  or takes a fee when it moves; the pool price within 5% of Chainlink where both tokens have a feed; balances that
  cover it; the exact amounts of the plan in the signed call. No swaps, zaps or aggregator routes.
- Errors never contain a private key or the RPC URL.

Fees: auto-compound takes 10% of the fees it adds back, and Cashmere pays the gas. Auto-range takes 0.15% of the amount
moved per move, and auto-exit 0.15% once. On v4, auto-compound needs no permission on the position: the wallet signs one
message per run (no gas), at most 30 at a time and for at most 90 days, and the tool hands them to the keeper store at
`api.cashmere.exchange`.

The tools read `api.cashmere.exchange` as a polite client: they send `User-Agent: cashmere-agent-sdk/<version>`, keep
answers for their cache lifetime, ask one request at a time per route group, stay under the per-minute limits, and wait
once on a 429.

| Variable | Effect |
|----------|--------|
| `CASHMERE_ROBINHOOD_RPC_URL` | Robinhood Chain RPC, https only (or a local node), never shown in errors. Default `https://rpc.mainnet.chain.robinhood.com` |
| `CASHMERE_GOATLP_MAX_DEPOSIT_USD=100` | Largest USD value of one `goatlp_add_liquidity` call |
| `CASHMERE_GOATLP_MAX_TOTAL_USD=500` | Largest USD value `goatlp_add_liquidity` deposits while the server runs |

Both limits value a deposit with the API's token prices and refuse it when a price is missing. The total counts a
deposit once it may have left the wallet, and gives it back when the transaction surely did not. The write tools sign with
`CASHMERE_EVM_PRIVATE_KEY`, on its own wallet: give the agent a dedicated one that holds only what it may deposit,
plus a little ETH for gas.

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

[`skills/goat-lp`](skills/goat-lp/SKILL.md) does the same for the Goat LP tools: it finds pools and positions, plans a
deposit or an automation, shows the plan, and executes it only after the user confirms. Install it the same way.

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
- The Goat LP write tools sign only what a plan the user saw contains, after decoding and simulating it, and refuse a
  contract whose code differs from the hash pinned in this package
- All contract addresses are public on-chain data

## Build

```bash
npm run build
```
