# Chains and recipient formats

| Chain id | Network | Recipient format | Gas token (smallest unit) | Explorer |
|---|---|---|---|---|
| `ethereum` | Ethereum | EVM | ETH (wei, 10^18) | https://etherscan.io |
| `base` | Base | EVM | ETH (wei, 10^18) | https://basescan.org |
| `arbitrum` | Arbitrum One | EVM | ETH (wei, 10^18) | https://arbiscan.io |
| `optimism` | OP Mainnet | EVM | ETH (wei, 10^18) | https://optimistic.etherscan.io |
| `unichain` | Unichain | EVM | ETH (wei, 10^18) | https://uniscan.xyz |
| `linea` | Linea | EVM | ETH (wei, 10^18) | https://lineascan.build |
| `worldchain` | World Chain | EVM | ETH (wei, 10^18) | https://worldscan.org |
| `polygon` | Polygon PoS | EVM | POL (10^18) | https://polygonscan.com |
| `avalanche` | Avalanche C-Chain | EVM | AVAX (10^18) | https://snowtrace.io |
| `sei` | Sei | EVM | SEI (10^18) | https://seitrace.com |
| `sonic` | Sonic | EVM | S (10^18) | https://sonicscan.org |
| `hyperevm` | HyperEVM | EVM | HYPE (10^18) | https://hyperevmscan.io |
| `monad` | Monad | EVM | MON (10^18) | https://monadvision.com |
| `solana` | Solana | Solana | SOL (lamports, 10^9) | https://solscan.io |
| `aptos` | Aptos | Move | APT (octas, 10^8) | https://aptoscan.com |
| `sui` | Sui | Move | SUI (MIST, 10^9) | https://suiscan.xyz |

CCTP takes every recipient as 32 bytes, so an address in the wrong format would not bounce: the USDC would arrive at
an account nobody controls. `cashmere_bridge` refuses the formats below before signing, but check them with the user
anyway.

## EVM

- `0x` followed by 40 hex characters, such as `0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed`.
- A mixed-case address must match its EIP-55 checksum. An all-lowercase address is accepted.
- The same address exists on every EVM chain, but make sure the recipient controls it on the destination chain. A
  smart-contract wallet, such as a Safe, exists only on the chains where it was deployed. An exchange deposit
  address may accept USDC only on some networks.

## Solana

- The wallet (owner) address in base58, such as `9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`.
- Not the wallet's USDC token account: the SDK derives that from the wallet. A token account or other program
  address, including a multisig vault, is refused.

## Aptos and Sui

- `0x` followed by 64 hex characters.
- An EVM address (40 hex characters) is not an Aptos or Sui address, even when the same person owns both.

## Refused before signing

`cashmere_bridge` answers `Not sent: ...` without signing anything when:

- the recipient does not match the destination chain's format above;
- the recipient is the zero address or the USDC token itself;
- the amount is above the server's per-transfer limit (`CASHMERE_MCP_MAX_AMOUNT`).
