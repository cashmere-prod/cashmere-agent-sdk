// The Robinhood Chain side of the Goat LP tools: a small read interface (what the tools need from an RPC), its viem
// implementation, the signer interface, and the pin check (the live code hash of every pinned contract).
import {
  createPublicClient, createWalletClient, defineChain, http, keccak256, type Abi, type Address, type Chain, type Hex, type PublicClient, type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DEFAULT_ROBINHOOD_RPC_URL, EXPLORER_URL, GOAT_CHAIN_ID, GOAT_CHAIN_NAME, MULTICALL3, PINS, type PinKey,
} from './constants';

export interface McCall { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] }
export type McRes = { status: 'success'; result: unknown } | { status: 'failure'; error: unknown };

/** What the Goat LP tools read from Robinhood Chain */
export interface GoatChain {
  chainId(): Promise<number>;
  getCode(address: Address): Promise<Hex | undefined>;
  /** keccak256 of the runtime code at the address; null when there is no code */
  codeHash(address: Address): Promise<Hex | null>;
  read<T = unknown>(c: McCall): Promise<T>;
  /** many reads in one Multicall3 request; a failed read is a failure entry, never a throw */
  multicall(calls: readonly McCall[]): Promise<McRes[]>;
  /** eth_call from `from`; throws with the revert data on a revert */
  call(tx: { from: Address; to: Address; data: Hex; value?: bigint }): Promise<Hex>;
  /** unix seconds of the latest block */
  blockTimestamp(): Promise<number>;
  /** the ETH balance of an address, in wei */
  balance(address: Address): Promise<bigint>;
  waitReceipt(hash: Hex): Promise<TxReceipt>;
}

export interface TxLog { address: Address; topics: readonly Hex[]; data: Hex }
export interface TxReceipt { status: 'success' | 'reverted'; blockNumber: bigint; logs?: readonly TxLog[] }

export interface TypedDataToSign {
  domain: { name: string; chainId: number; verifyingContract: Address };
  types: { readonly Permit: readonly { readonly name: string; readonly type: string }[] };
  primaryType: 'Permit';
  message: { spender: Address; tokenId: bigint; nonce: bigint; deadline: bigint };
}

/** The wallet the write tools sign with. sendTransaction throws NotBroadcastError when the transaction never left the
 *  wallet (it could not be prepared or signed); any other error leaves the outcome unknown. */
export interface GoatSigner {
  address: Address;
  sendTransaction(tx: { to: Address; data: Hex; value: bigint }): Promise<Hex>;
  signTypedData(td: TypedDataToSign): Promise<Hex>;
}

/** A send that failed before the transaction was handed to the RPC: nothing can have reached the chain */
export class NotBroadcastError extends Error {
  constructor(readonly cause: unknown) {
    super((cause as { shortMessage?: string })?.shortMessage ?? (cause instanceof Error ? cause.message : String(cause)));
    this.name = 'NotBroadcastError';
  }
}
export const isNotBroadcast = (e: unknown): boolean => e instanceof NotBroadcastError;

export function robinhoodChain(rpcUrl: string = DEFAULT_ROBINHOOD_RPC_URL): Chain {
  return defineChain({
    id: GOAT_CHAIN_ID,
    name: GOAT_CHAIN_NAME,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'Robinhood Chain explorer', url: EXPLORER_URL } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
}

/** The viem implementation of GoatChain */
export function viemChain(rpcUrl: string = DEFAULT_ROBINHOOD_RPC_URL): GoatChain {
  const client = createPublicClient({ chain: robinhoodChain(rpcUrl), transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) }) as PublicClient;
  return {
    chainId: () => client.getChainId(),
    getCode: (address) => client.getCode({ address }),
    codeHash: async (address) => codeHashOf(await client.getCode({ address })),
    read: async <T>(c: McCall) => (await client.readContract({ address: c.address, abi: c.abi as Abi, functionName: c.functionName, args: (c.args ?? []) as unknown[] })) as T,
    multicall: async (calls) => {
      if (!calls.length) return [];
      // larger chunks than viem's default: fewer requests to the public RPC
      return (await client.multicall({ contracts: calls as never, allowFailure: true, batchSize: 16_384 })) as McRes[];
    },
    call: async (tx) => {
      const r = await client.call({ account: tx.from, to: tx.to, data: tx.data, value: tx.value ?? 0n });
      return (r.data ?? '0x') as Hex;
    },
    blockTimestamp: async () => Number((await client.getBlock({ blockTag: 'latest' })).timestamp),
    balance: (address) => client.getBalance({ address }),
    waitReceipt: async (hash) => {
      const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      return { status: r.status, blockNumber: r.blockNumber, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data })) };
    },
  };
}

/** The viem signer for a private key on Robinhood Chain (`transport` replaces the RPC in tests) */
export function viemSigner(privateKey: string, rpcUrl: string = DEFAULT_ROBINHOOD_RPC_URL, transport?: Transport): GoatSigner {
  const key = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
  const account = privateKeyToAccount(key);
  const chain = robinhoodChain(rpcUrl);
  const wallet = createWalletClient({ account, chain, transport: transport ?? http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });
  return {
    address: account.address,
    // prepared and signed in the process first, then handed to the RPC: a failure before the hand-over sent nothing
    sendTransaction: async (tx) => {
      let raw: Hex;
      try {
        const request = await wallet.prepareTransactionRequest({ account, chain, to: tx.to, data: tx.data, value: tx.value });
        raw = await wallet.signTransaction({ ...request, account, chain } as never);
      } catch (e) {
        throw new NotBroadcastError(e);
      }
      return wallet.sendRawTransaction({ serializedTransaction: raw });
    },
    signTypedData: (td) => account.signTypedData(td as never),
  };
}

/** The address of a private key (no RPC) */
export const addressOfKey = (privateKey: string): Address =>
  privateKeyToAccount((privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex).address;

/** keccak256 of runtime code (null when there is no code) */
export function codeHashOf(code: Hex | string | null | undefined): Hex | null {
  if (!code || code === '0x' || !/^0x[0-9a-fA-F]*$/.test(code)) return null;
  return keccak256(code as Hex);
}

export interface PinResult { ok: boolean; codehash: Hex | null; reason: string }

/** Reads the code of each pinned contract and compares its hash with the pin. A failed read is not ok. */
export async function checkPins(chain: GoatChain, keys: readonly PinKey[]): Promise<Record<PinKey, PinResult>> {
  const out = {} as Record<PinKey, PinResult>;
  await Promise.all(keys.map(async (k) => {
    const pin = PINS[k];
    try {
      const h = await chain.codeHash(pin.address);
      if (!h) out[k] = { ok: false, codehash: null, reason: `${pin.name} has no code at ${pin.address}.` };
      else if (h.toLowerCase() !== pin.codehash.toLowerCase()) out[k] = { ok: false, codehash: h, reason: `${pin.name} at ${pin.address} does not match the build pinned in this package.` };
      else out[k] = { ok: true, codehash: h, reason: `${pin.name} matches the pinned build.` };
    } catch {
      out[k] = { ok: false, codehash: null, reason: `Could not read the code of ${pin.name} on chain.` };
    }
  }));
  return out;
}

/** Explorer links */
export const txUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER_URL}/address/${address}`;
