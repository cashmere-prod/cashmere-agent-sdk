# cashmere-agent-sdk

TypeScript SDK for Cashmere CCTP cross-chain USDC transfers across EVM, Solana, Aptos, and Sui.

## Install

```bash
npm install cashmere-agent-sdk
```

## AI Agent / OpenClaw Integration

This SDK ships with a `SKILL.md` file that AI agents (Cursor, Codex, OpenClaw,
LangChain, etc.) can read to understand Cashmere CCTP capabilities. The skill
file is included in the npm package at `node_modules/cashmere-agent-sdk/SKILL.md`.

For OpenClaw-based agents, register the SDK as a tool:

```typescript
// OpenClaw tool registration example
import { CashmereCCTP } from 'cashmere-agent-sdk';
import { readFileSync } from 'fs';

const skillContext = readFileSync(
  require.resolve('cashmere-agent-sdk/SKILL.md'), 'utf-8'
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
import { CashmereCCTP } from 'cashmere-agent-sdk';

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

If `version` is omitted, the SDK picks the best available version:
1. V2 Fast (if supported for the route)
2. V2 Norm (if supported)
3. V1 (fallback)

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
| Linea           | N  | Y       | Y       | EVM, Solana only                |
| Worldchain      | N  | Y       | Y       | EVM, Solana only                |
| Sei             | N  | N       | Y       | EVM, Solana only                |
| Sonic           | N  | N       | Y       | EVM, Solana only                |
| HyperEVM        | N  | N       | Y       | EVM, Solana only                |
| Monad           | N  | N       | Y       | EVM, Solana only                |
| Solana          | Y  | N       | Y       | All EVM, Aptos, Sui             |
| Aptos           | Y  | N       | N       | Legacy EVM, Solana, Sui         |
| Sui             | Y  | N       | N       | Legacy EVM, Solana, Aptos       |

## Utilities

```typescript
import {
  CCTP_DOMAINS,
  USDC_ADDRESSES,
  isV1Supported,
  isV2FastSupported,
  resolveVersion,
  GasApiClient,
} from 'cashmere-agent-sdk';

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
