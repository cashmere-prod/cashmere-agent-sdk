# @cashmerelabs/cashmere-agent-sdk

TypeScript SDK for Cashmere CCTP cross-chain USDC transfers across EVM, Solana, Aptos, and Sui.

## Install

```bash
npm install @cashmerelabs/cashmere-agent-sdk
```

Requires Node.js 20.19 or later (22+ recommended): the Sui client is an ES module that the CommonJS build loads
with `require()`. Sui fullnodes no longer serve JSON-RPC, so the Sui `rpcUrl` is a gRPC endpoint (default
`https://fullnode.mainnet.sui.io:443`).

## AI Agent / OpenClaw Integration

This SDK ships with a `SKILL.md` file that AI agents (Cursor, Codex, OpenClaw,
LangChain, etc.) can read to understand Cashmere CCTP capabilities. The skill
file is included in the npm package at `node_modules/@cashmerelabs/cashmere-agent-sdk/SKILL.md`.

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

// Expose cctp.transfer() as an agent tool with SKILL.md as context
```

The SKILL.md provides:
- All supported chains, domain IDs, and contract addresses
- CCTP V1/V2 routing rules and fee structures
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

## Configuration

Only configure the chains you need:

```typescript
// EVM-only bot
const cctp = new CashmereCCTP({
  evm: { privateKey: process.env.EVM_KEY! },
});

// With custom RPC
const cctp = new CashmereCCTP({
  evm: {
    privateKey: process.env.EVM_KEY!,
    rpcUrl: 'https://my-rpc.example.com',
  },
  solana: {
    privateKey: process.env.SOL_KEY!,
    rpcUrl: 'https://my-solana-rpc.example.com',
  },
});

// Custom Gas API URL
const cctp = new CashmereCCTP({
  evm: { privateKey: process.env.EVM_KEY! },
  gasApiUrl: 'https://gas.cashmere.exchange',
});
```

## Transfer Parameters

```typescript
await cctp.transfer({
  from: 'ethereum',        // source chain
  to: 'arbitrum',          // destination chain
  amount: '100',           // USDC amount (human-readable, 6 decimals applied automatically)
  recipient: '0x...',      // destination address (any format per chain)
  version: 'v2-fast',      // optional: 'v1' | 'v2-fast' | 'v2-norm' (auto-resolved if omitted)
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
| Solana          | Y  | N       | Y       | All EVM, Aptos, Sui             |
| Aptos           | Y  | N       | Y       | All EVM, Solana, Sui            |
| Sui             | Y  | N       | Y       | All EVM, Solana, Aptos          |

V1 shows what the contracts still accept; the SDK sends every route over V2. Circle quotes no Fast fee from Aptos or
Sui, so transfers from them go V2 Norm; transfers to them go V2 Fast where the source has it.

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
resolveVersion('aptos', 'sui');            // 'v1'

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
console.log(sim.estimatedFee);      // { cashmere: '...', circleBurnBps: 1.3 }

if (sim.supported) {
  await cctp.transfer({ from: 'ethereum', to: 'arbitrum', amount: '100', recipient: '0x...' });
}
```

## Agent Framework Integration

### OpenAI Assistants / Function Calling

```typescript
import { bridgeToolSchema, simulateToolSchema } from '@cashmerelabs/cashmere-agent-sdk';

const tools = [
  { type: "function", function: bridgeToolSchema },
  { type: "function", function: simulateToolSchema },
];

// Pass to OpenAI chat completion
const response = await openai.chat.completions.create({
  model: "gpt-4",
  messages: [...],
  tools,
});
```

### LangChain

```typescript
import { CashmereCCTP } from '@cashmerelabs/cashmere-agent-sdk';
import { CashmereBridgeTool, CashmereSimulateTool } from '@cashmerelabs/cashmere-agent-sdk/tools/langchain';

const cctp = new CashmereCCTP({ evm: { privateKey: process.env.EVM_KEY! } });
const tools = [
  new CashmereBridgeTool(cctp),
  new CashmereSimulateTool(cctp),
];

// Use with any LangChain agent
const agent = createReactAgent({ llm, tools });
```

### crewAI

crewAI uses LangChain tools natively -- same `CashmereBridgeTool` and `CashmereSimulateTool` classes work directly.

## How It Works

1. SDK builds and signs a source-chain transaction (burn USDC via Cashmere wrapper)
2. Cashmere's own relayers automatically detect the burn, fetch Circle attestation, and mint USDC on the destination chain
3. No further action needed -- the destination transfer completes automatically

## Security

- Private keys are only used in-memory for transaction signing
- Never stored, logged, or transmitted anywhere except to the chain RPC
- The Gas API (`gas.cashmere.exchange`) only receives domain/fee parameters, never keys
- All contract addresses are public on-chain data

## Build

```bash
npm run build
```
