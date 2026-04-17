# Cashmere CCTP Cross-Chain USDC Transfer Skill

Use this skill when the user asks about Cashmere cross-chain USDC transfers, CCTP
contract calls, bridging between EVM / Solana / Aptos / Sui, or building
transactions against the Cashmere wrapper contracts.

This skill covers **source-side burns only** (sending USDC cross-chain).
Destination-side claim/mint is handled automatically by Cashmere's own relayers --
no user or SDK action is needed after the source transaction confirms.

**Security:** No private keys, mnemonics, or signer secrets are stored here.
All addresses below are public on-chain data. The Gas API URL is
`https://gas.cashmere.exchange` (production).

---

## SDK Usage (Programmatic)

This skill is bundled with `cashmere-agent-sdk`. If available, prefer calling
the SDK directly instead of building raw transactions:

```typescript
import { CashmereCCTP } from 'cashmere-agent-sdk';

const cctp = new CashmereCCTP({
  evm: { privateKey: process.env.EVM_PRIVATE_KEY },
  solana: { privateKey: process.env.SOLANA_PRIVATE_KEY },
  aptos: { privateKey: process.env.APTOS_PRIVATE_KEY },
  sui: { privateKey: process.env.SUI_PRIVATE_KEY },
});

const result = await cctp.transfer({
  from: 'ethereum',
  to: 'arbitrum',
  amount: '100',
  recipient: '0xDestinationAddress',
  version: 'v2-fast',
  feeMode: 'native',
});
// result.txHash, result.explorerUrl
```

Install: `npm install cashmere-agent-sdk`

---

## Architecture Overview

Every chain follows the same pattern:

```
User/Agent ──► Gas API (fee quote + signature)
          ──► Cashmere Wrapper Contract (verify sig, collect fees)
                  ──► Circle CCTP depositForBurn / depositForBurnWithHook
                          ──► Circle attestation (off-chain)
                                  ──► Cashmere relayers auto-mint on destination
```

---

## 1. Circle CCTP Domain IDs

| Domain | Chain         | Native | Notes                          |
|--------|---------------|--------|--------------------------------|
| 0      | Ethereum      | ETH    |                                |
| 1      | Avalanche     | AVAX   |                                |
| 2      | Optimism      | ETH    |                                |
| 3      | Arbitrum      | ETH    |                                |
| 5      | Solana        | SOL    |                                |
| 6      | Base          | ETH    |                                |
| 7      | Polygon       | POL    |                                |
| 8      | Sui           | SUI    |                                |
| 9      | Aptos         | APT    |                                |
| 10     | Unichain      | ETH    |                                |
| 11     | Linea         | ETH    |                                |
| 13     | Sonic         | S      |                                |
| 14     | Worldchain    | ETH    |                                |
| 15     | Monad         | MON    |                                |
| 16     | Sei           | SEI    |                                |
| 19     | HyperEVM      | HYPE   | Same domain as Hyperliquid Core|

---

## 2. CCTP Versions, Durations, and Fee Structures

### V1 (Legacy Attestation-Based)

Requires Circle attestation before destination mint. Supported on
EVM <-> EVM (older chains), EVM <-> Solana, EVM <-> Aptos, EVM <-> Sui,
Aptos <-> Solana, Aptos <-> Sui, Sui <-> Solana.

**Not supported on:** Linea, Worldchain, Sei, Sonic, HyperEVM, Monad (V2-only
chains).

| Source Chain  | Estimated Duration |
|---------------|--------------------|
| Ethereum      | ~15 minutes        |
| Arbitrum      | ~15 minutes        |
| Base          | ~15 minutes        |
| Optimism      | ~15 minutes        |
| Unichain      | ~15 minutes        |
| Polygon       | ~2 minutes         |
| Avalanche     | ~8 seconds         |
| Solana        | ~25 seconds        |
| Sui           | ~8 seconds         |
| Aptos         | ~8 seconds         |

**Circle burn fee:** 0 BPS (no Circle burn fee on V1).

### V2 Fast (Threshold 1000)

Attestation-free fast finality. Supported on EVM <-> EVM and EVM <-> Solana
only.

| Source Chain  | Estimated Duration |
|---------------|--------------------|
| Ethereum      | ~15 seconds        |
| Arbitrum      | ~15 seconds        |
| Base          | ~15 seconds        |
| Optimism      | ~15 seconds        |
| Unichain      | ~15 seconds        |
| Worldchain    | ~15 seconds        |
| Linea         | ~15 seconds        |
| Polygon       | ~8 seconds         |
| Avalanche     | ~8 seconds         |
| Sonic         | ~8 seconds         |
| Monad         | ~8 seconds         |
| HyperEVM      | ~5 seconds         |
| Sei           | ~5 seconds         |
| Solana        | ~15 seconds        |

**Circle burn fee:** Variable BPS from Circle Iris API. Fetched per route.
`minFinalityThreshold = 1000`.

**Not supported from:** Avalanche, Sei, Sonic, Polygon, Solana, HyperEVM,
Monad (these only support V2 Norm, not V2 Fast).

### V2 Norm (Threshold 2000)

Standard finality V2. Supported on all EVM <-> EVM and EVM <-> Solana routes.

| Source Chain  | Estimated Duration |
|---------------|--------------------|
| Ethereum      | ~15 minutes        |
| Arbitrum      | ~15 minutes        |
| Base          | ~15 minutes        |
| Optimism      | ~15 minutes        |
| Unichain      | ~15 minutes        |
| Worldchain    | ~15 minutes        |
| Linea         | ~24 hours          |
| Polygon       | ~8 seconds         |
| Avalanche     | ~8 seconds         |
| Sonic         | ~8 seconds         |
| Monad         | ~8 seconds         |
| HyperEVM      | ~5 seconds         |
| Sei           | ~5 seconds         |
| Solana        | ~25 seconds        |

**Circle burn fee:** Variable BPS from Circle Iris API (typically lower than
V2 Fast). `minFinalityThreshold = 2000`.

### Fee Calculation Summary

**Cashmere protocol fee (all chains, all versions):**
```
total_fee = (amount * fee_bp / 10000) + static_fee
```
- `fee_bp`: On-chain basis points, max 100 (1%).
- `static_fee`: From the Gas API quote.
  - **Native mode** (`isNative=true`): static fee paid in native token (ETH/SOL/APT/SUI/etc.), USDC formula uses `static_fee=0`.
  - **Stable mode** (`isNative=false`): static fee added to USDC deduction.
- **Gas drop:** Currently disabled. Pass `gasDropAmount=0` in all transfers.

**Circle V2 burn fee (maxFee passed on-chain):**
```
bpsTenths = ceil(minimumFee_from_iris * 10)
maxFee = ceil(amount * bpsTenths / 100000)
```
Where `minimumFee` comes from Circle Iris API (can be fractional BPS like 1.3).

---

## 3. Contract Addresses

### EVM — CashmereCCTP Wrapper

| Chain      | CashmereCCTP Address                         |
|------------|----------------------------------------------|
| Ethereum   | `0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6` |
| Avalanche  | `0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6` |
| Polygon    | `0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6` |
| Arbitrum   | `0x3412ef459221d1581a08dcD56Ee55B8FaeBf5eEA` |
| Optimism   | `0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6` |
| Base       | `0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6` |
| Unichain   | `0xd002a7172Ac6f90657FCb918B3f7e36372a4bA80` |
| Linea      | `0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6` |
| Worldchain | `0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6` |
| Sei        | `0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6` |
| Sonic      | `0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6` |
| HyperEVM   | `0x15b2810232ec96ff083ca6d8b785cb930d241d83` |
| Monad      | `0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6` |

### Solana — Anchor Program

| Item                              | Address / Key                                        |
|-----------------------------------|------------------------------------------------------|
| Cashmere CCTP Program             | `5RsvKL6LFq6yEFiAXEwgYHAN3aLFypeB4AaafdeDnHqM`     |
| Address Lookup Table              | `865YCTTsymGpBjLMTvjd3T3RCGT8yvxnAHhyKZqRFfLi`     |
| Circle Message Transmitter V1     | `CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd`      |
| Circle Token Messenger Minter V1  | `CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3`      |
| Circle Message Transmitter V2     | `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`      |
| Circle Token Messenger Minter V2  | `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`      |
| USDC Mint                         | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`     |

**PDAs:**
- Config: `seeds = ["config"]` under Cashmere program
- Custodian: `seeds = ["emitter"]` under Cashmere program
- Custody ATA: `seeds = ["__custody"]` (transient, closed after burn)

### Aptos — Move Module

| Item                | Address                                                              |
|---------------------|----------------------------------------------------------------------|
| Transfer Module     | `0xe49afb1896889e3e1dd7bcbb9e31d1df8221899d3d368e98588ac6b4d84b136d` |
| Entry Function      | `{module}::transfer::transfer_outer`                                 |
| USDC Coin Type      | `0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b` |

### Sui — Move Package

| Item                          | Address / Object ID                                                      |
|-------------------------------|--------------------------------------------------------------------------|
| Cashmere Transfer Package     | `0xdf37112aacb7d3535f7b3b754b9a7b9fa1a6b3a756288dc734522c603c6f11a4`     |
| Cashmere Config (shared)      | `0x5f1b2e205777713f44a99894d98e1e66e33dc11ff88e50108c94ee79b7ea3d67`     |
| Circle TokenMessengerMinter   | `0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e`     |
| Message Transmitter State     | `0xf68268c3d9b1df3215f2439400c1c4ea08ac4ef4bb7d6f3ca6a2a239e17510af`     |
| TokenMessengerMinter State    | `0x45993eecc0382f37419864992c12faee2238f5cfe22b98ad3bf455baf65c8a2f`     |
| USDC Treasury                 | `0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7`     |
| DenyList                      | `0x403`                                                                  |
| USDC Type                     | `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC` |

### USDC Addresses (per chain)

| Chain      | USDC Address                                       |
|------------|-----------------------------------------------------|
| Ethereum   | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`      |
| Avalanche  | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`      |
| Polygon    | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`      |
| Arbitrum   | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`      |
| Optimism   | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`      |
| Base       | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`      |
| Unichain   | `0x078D782b760474a361dDA0AF3839290b0EF57AD6`      |
| Linea      | `0x176211869cA2b568f2A7D4EE941E073a821EE1ff`      |
| Worldchain | `0x79A02482A880bCe3F13E09da970dC34dB4cD24D1`      |
| Sei        | `0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392`      |
| Sonic      | `0x29219dd400f2Bf60E5a23d13Be72B486D4038894`      |
| HyperEVM   | `0xb88339CB7199b77E23DB6E890353E22632Ba630f`      |
| Monad      | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`      |
| Solana     | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`   |
| Aptos      | `0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b` |
| Sui        | `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC` |

---

## 4. Gas API — Fee Quotes and Signatures

**Base URL:** `https://gas.cashmere.exchange`

### ECDSA Signature (EVM chains)

```
GET /getEcdsaSig_native?localDomain={domain}&destinationDomain={domain}&isNative={true|false}&isV2={true|false}
```

**Response:**
```json
{
  "fee": "128000",
  "deadline": "1713400000",
  "signature": "0x...",
  "cctpVersion": "1"
}
```

Frontend converts: `fee = BigInt(fee)`, `deadline = BigInt(deadline)`,
`signature` used as-is (hex string).

### Ed25519 Signature (Solana, Aptos, Sui)

```
GET /getEd25519Sig_native?localDomain={domain}&destinationDomain={domain}&isNative={true|false}&version={1|2}
```

**Response:**
```json
{
  "signature": "0x...",
  "message": "0x...",
  "publicKey": "0x...",
  "destinationDomain": "3",
  "fee": "128000",
  "deadline": "1713400000"
}
```

Frontend converts hex strings to `Buffer`: `Buffer.from(sig.slice(2), 'hex')`.

### Circle V2 Burn Fee (via Netlify proxy to Iris)

```
GET /.netlify/functions/get-burn-fees?localDomain={d}&destinationDomain={d}&threshold={1000|2000}
```

Proxies to: `https://iris-api.circle.com/v2/burn/USDC/fees/{localDomain}/{destinationDomain}`

**Response:**
```json
{
  "finalityThreshold": 1000,
  "minimumFee": 1.3
}
```

`minimumFee` is in BPS (can be fractional).

---

## 5. EVM Transfer Pattern

### ABI Functions

```solidity
// V1
function transfer(TransferParams memory _params) external payable;
function transferWithPermit(TransferParams memory _params, PermitParams memory _permitParams) external payable;

// V2
function transferV2(TransferV2Params memory _params) external payable;
function transferV2WithPermit(TransferV2Params memory _params, PermitParams memory _permitParams) external payable;
```

### TransferParams (V1)

```solidity
struct TransferParams {
    uint64  amount;            // USDC amount in 6-decimal units
    uint128 fee;               // Static fee from Gas API
    uint64  deadline;          // Unix timestamp
    uint128 gasDropAmount;     // Pass 0 (gas drop currently disabled)
    uint32  destinationDomain; // Circle CCTP domain
    bytes32 recipient;         // 32-byte padded destination address
    bytes32 solanaOwner;       // Solana wallet owner (0x0 if not Solana dest)
    bool    isNative;          // true = fees in native token
    bytes   signature;         // ECDSA from Gas API
}
```

### TransferV2Params

Same as V1 plus:
```solidity
    uint256 maxFee;                // Calculated from Circle Iris minimumFee
    uint32  minFinalityThreshold;  // 1000 (fast) or 2000 (norm)
    bytes   hookData;              // Always "0x00" for standard transfers
```

### PermitParams (for WithPermit variants)

```solidity
struct PermitParams {
    uint256 value;      // USDC amount to permit
    uint256 deadline;   // Permit deadline (transfer deadline + 6000)
    bytes   signature;  // EIP-2612 permit signature
}
```

### TypeScript Example (viem)

```typescript
import { writeContract, simulateContract } from '@wagmi/core';

const GAS_API = 'https://gas.cashmere.exchange';

async function evmCctpTransfer(
  srcChain: string, // e.g. 'ethereum'
  srcDomain: number, // e.g. 0
  dstDomain: number, // e.g. 3 (arbitrum)
  amount: bigint, // USDC in 6 decimals, e.g. 100_000_000n for 100 USDC
  recipientBytes32: `0x${string}`,
  isNative: boolean,
  isV2: boolean,
) {
  // 1. Get fee quote + signature from Gas API
  const sigResp = await fetch(
    `${GAS_API}/getEcdsaSig_native?localDomain=${srcDomain}&destinationDomain=${dstDomain}&isNative=${isNative}&isV2=${isV2}`
  ).then(r => r.json());

  const fee = BigInt(sigResp.fee);
  const deadline = BigInt(sigResp.deadline);
  const signature = sigResp.signature;

  // 2. Calculate msg.value (native fee only when isNative=true)
  const value = isNative ? fee : 0n;

  // 3. Build args
  if (!isV2) {
    const args = [{
      amount,
      fee,
      deadline,
      gasDropAmount: 0n, // gas drop currently disabled
      destinationDomain: dstDomain,
      recipient: recipientBytes32,
      solanaOwner: '0x' + '0'.repeat(64),
      isNative,
      signature,
    }];

    // Simulate then send
    await simulateContract(config, {
      address: CASHMERE_CCTP_ADDRESS, // per chain
      abi: cashmereCctpAbi,
      functionName: 'transfer', // or 'transferWithPermit'
      args,
      value,
    });

    return writeContract(config, { /* same params */ });
  } else {
    // V2: fetch burn fee from Circle Iris
    const burnFee = await fetch(
      `/.netlify/functions/get-burn-fees?localDomain=${srcDomain}&destinationDomain=${dstDomain}&threshold=1000`
    ).then(r => r.json());

    const bpsTenths = Math.ceil((burnFee.minimumFee ?? 100) * 10);
    const maxFee = (amount * BigInt(bpsTenths) + 99999n) / 100000n;

    const args = [{
      amount,
      maxFee,
      fee,
      deadline,
      gasDropAmount: 0n, // gas drop currently disabled
      destinationDomain: dstDomain,
      minFinalityThreshold: 1000, // or 2000 for norm
      recipient: recipientBytes32,
      solanaOwner: '0x' + '0'.repeat(64),
      isNative,
      hookData: '0x00',
      signature,
    }];

    // Simulate then send (transferV2 or transferV2WithPermit)
  }
}
```

### On-Chain Signature Verification (EVM)

The contract verifies `ecrecover` on:
```
keccak256(abi.encodePacked(
  localDomain,        // uint32
  destinationDomain,  // uint32
  fee,                // uint128
  deadline,           // uint64
  isNative,           // bool
  uint8(1)            // version: 1 for V1, 2 for V2
))
```

---

## 6. Solana Transfer Pattern

### Instructions (Anchor IDL)

- `transfer` (V1): `usdc_amount`, `destination_domain`, `recipient: [u8;32]`, `solana_owner: [u8;32]`, `fee`, `deadline`, `gas_drop_amount` (pass 0), `fee_is_native`
- `transfer_v2`: Same as above plus `max_fee`, `min_finality_threshold`

### Transaction Structure

A Solana CCTP transfer is a **VersionedTransaction** with these instructions:

1. `ComputeBudgetProgram.setComputeUnitLimit({ units: 160_000 })`
2. `Ed25519Program.createInstructionWithPublicKey({ publicKey, message, signature })` — from Gas API response
3. `program.methods.transfer(...)` or `program.methods.transferV2(...)` — Anchor instruction

Signed by: wallet first (allows Phantom Lighthouse), then `cctpMessageSigner` keypair.

Uses Address Lookup Table `865YCTTsymGpBjLMTvjd3T3RCGT8yvxnAHhyKZqRFfLi` for compressed V0 messages.

### Key Accounts

```typescript
{
  ownerTokenAccount: userUsdcAta,
  feeCollectorSolAccount: config.feeCollectorSol,
  feeCollectorUsdcAccount: config.feeCollectorUsdc,
  gasDropCollectorSolAccount: config.gasDropCollectorSol,   // still required by IDL
  gasDropCollectorUsdcAccount: config.gasDropCollectorUsdc, // still required by IDL
  owner: walletPublicKey,
  remoteTokenMessenger: PDA("remote_token_messenger", [destDomain.toString()]),
  burnSource: userUsdcAta,
  messageSentEventData: cctpMessageSigner.publicKey, // new Keypair per tx
  // V2 only:
  tokenMessengerMinterProgram: TOKEN_MESSENGER_MINTER_V2_PROGRAM_ID,
  messageTransmitterProgram: MESSAGE_TRANSMITTER_V2_PROGRAM_ID,
}
```

### TypeScript Example

```typescript
import { Program } from '@coral-xyz/anchor';
import { Ed25519Program, Keypair, PublicKey, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';

const GAS_API = 'https://gas.cashmere.exchange';
const PROGRAM_ID = new PublicKey('5RsvKL6LFq6yEFiAXEwgYHAN3aLFypeB4AaafdeDnHqM');

async function solanaCctpTransfer(
  connection: Connection,
  wallet: WalletAdapter,
  amount: bigint,
  destDomain: number,
  recipientBytes32: number[],
  isNative: boolean,
  isV2: boolean,
) {
  // 1. Get Ed25519 signature from Gas API
  const sigResp = await fetch(
    `${GAS_API}/getEd25519Sig_native?localDomain=5&destinationDomain=${destDomain}&isNative=${isNative}&version=${isV2 ? 2 : 1}`
  ).then(r => r.json());

  const signature = Buffer.from(sigResp.signature.slice(2), 'hex');
  const message = Buffer.from(sigResp.message.slice(2), 'hex');
  const publicKey = Buffer.from(sigResp.publicKey.slice(2), 'hex');

  // 2. Build Ed25519 verify instruction
  const signatureIx = Ed25519Program.createInstructionWithPublicKey({
    publicKey, message, signature
  });

  // 3. Build Anchor transfer instruction
  const cctpMessageSigner = new Keypair();
  const transferIx = await program.methods
    .transfer(
      new BN(amount.toString()),
      sigResp.destinationDomain,
      recipientBytes32,
      solanaOwnerBytes32,
      new BN(sigResp.fee),
      new BN(sigResp.deadline),
      new BN(0), // gas drop disabled
      isNative,
    )
    .accounts({ /* see Key Accounts above */ })
    .instruction();

  // 4. Assemble and sign
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 160_000 });
  const lookupTable = await connection.getAddressLookupTable(ALT_ADDRESS);

  const tx = new VersionedTransaction(
    new TransactionMessage({
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      payerKey: wallet.publicKey,
      instructions: [computeIx, signatureIx, transferIx],
    }).compileToV0Message([lookupTable.value])
  );

  tx = await wallet.signTransaction(tx);
  tx.sign([cctpMessageSigner]);

  return connection.sendTransaction(tx);
}
```

---

## 7. Aptos Transfer Pattern

### Entry Function

```
{MODULE_ADDR}::transfer::transfer_outer
```
Where `MODULE_ADDR = 0xe49afb1896889e3e1dd7bcbb9e31d1df8221899d3d368e98588ac6b4d84b136d`

### Arguments (positional)

| Index | Type       | Description                                     |
|-------|------------|-------------------------------------------------|
| 0     | u64        | USDC amount (6 decimals)                        |
| 1     | u64        | Native fee amount (0 if stable mode)            |
| 2     | u32        | Destination domain                              |
| 3     | address    | Recipient (bytes32 hex)                         |
| 4     | address    | Solana owner (0x0 if not Solana destination)    |
| 5     | u64        | Static fee from Gas API                         |
| 6     | u64        | Deadline from Gas API                           |
| 7     | u64        | Gas drop amount (pass 0, currently disabled)    |
| 8     | bool       | isNative                                        |
| 9     | vector<u8> | Ed25519 signature bytes                         |

### TypeScript Example

```typescript
import { InputEntryFunctionData } from '@aptos-labs/ts-sdk';

const GAS_API = 'https://gas.cashmere.exchange';
const MODULE = '0xe49afb1896889e3e1dd7bcbb9e31d1df8221899d3d368e98588ac6b4d84b136d';

async function aptosCctpTransfer(
  aptosClient: AptosClient,
  senderAddress: string,
  amount: bigint,
  destDomain: number,
  recipientBytes32: string,
  isNative: boolean,
) {
  // 1. Get Ed25519 signature from Gas API (domain 9 = Aptos)
  const sigResp = await fetch(
    `${GAS_API}/getEd25519Sig_native?localDomain=9&destinationDomain=${destDomain}&isNative=${isNative}`
  ).then(r => r.json());

  const signature = Buffer.from(sigResp.signature.slice(2), 'hex');
  const fee = sigResp.fee;
  const deadline = sigResp.deadline;

  // 2. Build transaction
  const txData: InputEntryFunctionData = {
    function: `${MODULE}::transfer::transfer_outer`,
    typeArguments: [],
    functionArguments: [
      amount.toString(),
      isNative ? BigInt(fee).toString() : '0', // native fee amount
      destDomain,
      recipientBytes32,
      '0x' + '0'.repeat(64), // solanaOwner
      fee,
      deadline,
      '0', // gas drop disabled
      isNative,
      Array.from(signature), // Pontem: Array, others: Uint8Array
    ],
  };

  // 3. Simulate and submit
  const transaction = await aptosClient.transaction.build.simple({
    sender: senderAddress,
    data: txData,
  });

  // Sign and submit via wallet adapter
}
```

**Note:** Pontem wallet requires `Array.from(signature)` format; other wallets
(Petra, Nightly) accept `Uint8Array` directly.

---

## 8. Sui Transfer Pattern

### Three-Step PTB (Programmable Transaction Block)

Sui uses a single atomic PTB with three `moveCall` steps:

#### Step 1: Cashmere prepare

```
target: {package}::transfer::prepare_deposit_for_burn_ticket
typeArguments: [USDC_TYPE]
arguments: [usdcCoin, nativeFeeCoin, destDomain, recipient, solanaOwner,
            fee, deadline, gasDropAmount (pass 0), isNative, signatureVector,
            configObject, clockObject]
returns: [ticket, depositInfo]
```

#### Step 2: Circle deposit

```
target: {tokenMessengerMinter}::deposit_for_burn::deposit_for_burn_with_package_auth
typeArguments: [USDC_TYPE, AUTH_STRUCT]
arguments: [ticket, tmmState, mtState, denyList, usdcTreasury]
returns: [burnMessage, message]
```

#### Step 3: Cashmere finalize

```
target: {package}::transfer::post_deposit_for_burn
arguments: [burnMessage, message, depositInfo, configObject]
```

### TypeScript Example

```typescript
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';

const GAS_API = 'https://gas.cashmere.exchange';
const CASHMERE_PKG = '0xdf37112aacb7d3535f7b3b754b9a7b9fa1a6b3a756288dc734522c603c6f11a4';
const CASHMERE_CONFIG = '0x5f1b2e205777713f44a99894d98e1e66e33dc11ff88e50108c94ee79b7ea3d67';
const TMM_PKG = '0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e';
const MT_STATE = '0xf68268c3d9b1df3215f2439400c1c4ea08ac4ef4bb7d6f3ca6a2a239e17510af';
const TMM_STATE = '0x45993eecc0382f37419864992c12faee2238f5cfe22b98ad3bf455baf65c8a2f';
const USDC_TREASURY = '0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7';
const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

async function suiCctpTransfer(
  suiClient: SuiClient,
  senderAddress: string,
  amount: bigint,
  destDomain: number,
  recipientBytes32: string,
  isNative: boolean,
) {
  // 1. Get Ed25519 signature from Gas API (domain 8 = Sui)
  const sigResp = await fetch(
    `${GAS_API}/getEd25519Sig_native?localDomain=8&destinationDomain=${destDomain}&isNative=${isNative}`
  ).then(r => r.json());

  const signature = Buffer.from(sigResp.signature.slice(2), 'hex');

  // 2. Build PTB
  const tx = new Transaction();

  const usdcCoin = coinWithBalance({
    type: USDC_TYPE,
    balance: amount,
  });

  const nativeCoin = tx.splitCoins(tx.gas, [
    tx.pure.u64(isNative ? BigInt(sigResp.fee).toString() : '0')
  ]);

  // Step 1: prepare
  const [ticket, depositInfo] = tx.moveCall({
    target: `${CASHMERE_PKG}::transfer::prepare_deposit_for_burn_ticket`,
    typeArguments: [USDC_TYPE],
    arguments: [
      usdcCoin, nativeCoin,
      tx.pure.u32(destDomain),
      tx.pure.address(recipientBytes32),
      tx.pure.address('0x' + '0'.repeat(64)),
      tx.pure.u64(sigResp.fee),
      tx.pure.u64(sigResp.deadline),
      tx.pure.u64('0'), // gas drop disabled
      tx.pure.bool(isNative),
      tx.pure.vector('u8', Array.from(signature)),
      tx.object(CASHMERE_CONFIG),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  // Step 2: Circle burn
  const [burnMessage, message] = tx.moveCall({
    target: `${TMM_PKG}::deposit_for_burn::deposit_for_burn_with_package_auth`,
    typeArguments: [USDC_TYPE, `${CASHMERE_PKG}::transfer::Auth`],
    arguments: [
      ticket,
      tx.object(TMM_STATE),
      tx.object(MT_STATE),
      tx.object('0x403'),
      tx.object(USDC_TREASURY),
    ],
  });

  // Step 3: finalize
  tx.moveCall({
    target: `${CASHMERE_PKG}::transfer::post_deposit_for_burn`,
    arguments: [burnMessage, message, depositInfo, tx.object(CASHMERE_CONFIG)],
  });

  tx.setSenderIfNotSet(senderAddress);

  // 3. Sign and execute via wallet
  return suiSignAndExecuteTransaction({ transaction: tx });
}
```

---

## 9. Recipient Address Encoding

All chains encode the destination address as **bytes32**:

- **EVM -> EVM**: Left-pad 20-byte address to 32 bytes.
- **Any -> Solana**: Compute the recipient's USDC Associated Token Account
  (ATA) and encode as bytes32. Also pass `solanaOwner` as the wallet pubkey in
  bytes32. Use `getAssociatedTokenAddressSync(USDC_MINT, walletPubkey)`.
- **Any -> Aptos/Sui**: The address is already 32 bytes.
- **Solana owner field**: Set to `0x0...0` (64 hex zeros) when destination is
  not Solana.

---

## 10. Version Routing Rules — Per Chain

### Source Chain Capabilities

Which CCTP versions each chain can **send from**:

| Source Chain | V1 (0 BPS) | V2 Fast (1000) | V2 Norm (2000) | Possible Destinations                          |
|--------------|------------|----------------|----------------|-------------------------------------------------|
| Ethereum     | Y          | Y              | Y              | All EVM, Solana, Aptos, Sui                     |
| Arbitrum     | Y          | Y              | Y              | All EVM, Solana, Aptos, Sui                     |
| Base         | Y          | Y              | Y              | All EVM, Solana, Aptos, Sui                     |
| Optimism     | Y          | Y              | Y              | All EVM, Solana, Aptos, Sui                     |
| Unichain     | Y          | Y              | Y              | All EVM, Solana, Aptos, Sui                     |
| Polygon      | Y          | N              | Y              | All EVM, Solana, Aptos, Sui                     |
| Avalanche    | Y          | N              | Y              | All EVM, Solana, Aptos, Sui                     |
| Linea        | N          | Y              | Y              | All EVM, Solana only (V2-only chain)            |
| Worldchain   | N          | Y              | Y              | All EVM, Solana only (V2-only chain)            |
| Sei          | N          | N              | Y              | All EVM, Solana only (V2-only, no V2 Fast)      |
| Sonic        | N          | N              | Y              | All EVM, Solana only (V2-only, no V2 Fast)      |
| HyperEVM     | N          | N              | Y              | All EVM, Solana only (V2-only, no V2 Fast)      |
| Monad        | N          | N              | Y              | All EVM, Solana only (V2-only, no V2 Fast)      |
| Solana       | Y          | N              | Y              | All EVM (V1+V2 Norm), Aptos (V1), Sui (V1)     |
| Aptos        | Y          | N              | N              | V1-legacy EVM, Solana, Sui (V1 only)            |
| Sui          | Y          | N              | N              | V1-legacy EVM, Solana, Aptos (V1 only)          |

### Destination Chain Constraints

Which versions can **send to** each destination:

| Destination  | Can receive V1 | Can receive V2 | Notes                                       |
|--------------|---------------|----------------|----------------------------------------------|
| Ethereum     | Y             | Y              |                                              |
| Arbitrum     | Y             | Y              |                                              |
| Base         | Y             | Y              |                                              |
| Optimism     | Y             | Y              |                                              |
| Unichain     | Y             | Y              |                                              |
| Polygon      | Y             | Y              |                                              |
| Avalanche    | Y             | Y              |                                              |
| Linea        | N             | Y              | V2-only destination                          |
| Worldchain   | N             | Y              | V2-only destination                          |
| Sei          | N             | Y              | V2-only destination                          |
| Sonic        | N             | Y              | V2-only destination                          |
| HyperEVM     | N             | Y              | V2-only destination                          |
| Monad        | N             | Y              | V2-only destination                          |
| Solana       | Y             | Y              | V1 from any; V2 from EVM only               |
| Aptos        | Y             | N              | V1 only (from V1-legacy EVM, Solana, Sui)    |
| Sui          | Y             | N              | V1 only (from V1-legacy EVM, Solana, Aptos)  |

### V1-Unsupported Chains (V2-only)

These chains have **no V1 support** — neither as source nor destination:
`linea`, `worldchain`, `sei`, `sonic`, `hyperevm`, `monad`, `stable`, `megaeth`

### V2 Fast-Unsupported Sources

These chains can only send V2 Norm (threshold 2000), **not** V2 Fast (threshold 1000):
`avalanche`, `sei`, `sonic`, `polygon`, `solana`, `hyperevm`, `monad`

---

## 11. Source Code References

| Area       | Path                                                     |
|------------|----------------------------------------------------------|
| EVM Contract | `evm/src/CashmereCCTP.sol`                             |
| Solana Program | `sol/programs/cashmere_cctp/src/`                    |
| Solana IDL   | `sol/target/idl/cashmere_cctp.json`                    |
| Aptos Module | `aptos/build/cashmere_cctp/sources/transfer.move`      |
| Sui Module   | `sui/sources/transfer.move`                            |
