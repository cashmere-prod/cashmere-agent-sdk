import { z } from 'zod';
import type { BurnFeeResponse } from './types';
import { GAS_API_URL } from './constants';

const IRIS_API_URL = 'https://iris-api.circle.com';

// A transaction is built from these responses, so their shape is checked, not assumed
const decimalString = z.string().regex(/^\d+$/, 'expected a decimal integer string');
const hexString = z.string().regex(/^0x([0-9a-fA-F]{2})+$/, 'expected 0x-prefixed hex');

const ecdsaSignatureSchema = z.object({
  fee: decimalString,
  deadline: decimalString,
  signature: hexString,
});

const ed25519SignatureSchema = z.object({
  signature: hexString.refine(s => s.length === 2 + 2 * 64, 'expected a 64-byte signature'),
  message: hexString,
  publicKey: hexString.refine(s => s.length === 2 + 2 * 32, 'expected a 32-byte public key'),
  destinationDomain: decimalString,
  fee: decimalString,
  deadline: decimalString,
});

const burnFeeSchema = z.array(z.object({
  finalityThreshold: z.number().int().nonnegative(),
  minimumFee: z.number().nonnegative(),
}));

export interface GasApiClientOptions {
  // Per attempt: without it a hung endpoint stalls the transfer for minutes
  timeoutMs?: number;
  retries?: number;
}

// The Gas API sets the fee and signs the quote, so it is reached over TLS only. Plain http is for a local mock.
function checkedBaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`gasApiUrl "${url}" is not a URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(`gasApiUrl "${url}" must use https`);
  }
  return url.replace(/\/+$/, '');
}

async function fetchWithRetry<T>(url: string, schema: z.ZodType<T>, options: GasApiClientOptions, baseDelay = 1000): Promise<T> {
  const { timeoutMs = 15_000, retries = 3 } = options;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const parsed = schema.safeParse(await res.json());
      if (!parsed.success) throw new Error(`unexpected response from ${new URL(url).host}: ${parsed.error.issues[0]?.message}`);
      return parsed.data;
    } catch (err) {
      lastError = err as Error;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError!;
}

export class GasApiClient {
  private baseUrl: string;
  private options: GasApiClientOptions;

  constructor(baseUrl?: string, options: GasApiClientOptions = {}) {
    this.baseUrl = checkedBaseUrl(baseUrl ?? GAS_API_URL);
    this.options = options;
  }

  async getEcdsaSignature(
    localDomain: number,
    destinationDomain: number,
    isV2: boolean,
    isNative: boolean,
  ): Promise<{ fee: bigint; deadline: bigint; signature: `0x${string}` }> {
    const url = `${this.baseUrl}/getEcdsaSig_native?localDomain=${localDomain}&destinationDomain=${destinationDomain}&isNative=${isNative}&isV2=${isV2}`;
    const data = await fetchWithRetry(url, ecdsaSignatureSchema, this.options);
    return {
      fee: BigInt(data.fee),
      deadline: BigInt(data.deadline),
      signature: data.signature as `0x${string}`,
    };
  }

  async getEd25519Signature(
    localDomain: number,
    destinationDomain: number,
    isNative: boolean,
    version?: number,
  ): Promise<{
    signature: Buffer;
    message: Buffer;
    publicKey: Buffer;
    destinationDomain: number;
    fee: string;
    deadline: string;
  }> {
    const versionParam = version ? `&version=${version}` : '';
    const url = `${this.baseUrl}/getEd25519Sig_native?localDomain=${localDomain}&destinationDomain=${destinationDomain}&isNative=${isNative}${versionParam}`;
    const data = await fetchWithRetry(url, ed25519SignatureSchema, this.options);
    return {
      signature: Buffer.from(data.signature.slice(2), 'hex'),
      message: Buffer.from(data.message.slice(2), 'hex'),
      publicKey: Buffer.from(data.publicKey.slice(2), 'hex'),
      destinationDomain: parseInt(data.destinationDomain, 10),
      fee: data.fee,
      deadline: data.deadline,
    };
  }

  async getBurnFee(
    localDomain: number,
    destinationDomain: number,
    threshold: number,
  ): Promise<BurnFeeResponse> {
    const url = `${IRIS_API_URL}/v2/burn/USDC/fees/${localDomain}/${destinationDomain}`;
    const data = await fetchWithRetry(url, burnFeeSchema, this.options);

    const match = data.find(d => d.finalityThreshold === threshold);
    if (match) return match;

    if (data.length === 0) {
      throw new Error(`No burn fee data from Circle Iris for ${localDomain} -> ${destinationDomain}`);
    }

    const sorted = [...data].sort((a, b) => a.finalityThreshold - b.finalityThreshold);
    return sorted[0];
  }
}
