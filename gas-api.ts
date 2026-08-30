import { z } from 'zod';
import type { BurnFeeResponse } from './types';
import { GAS_API_URL, IRIS_API_URL } from './constants';

/// Every quote request has to complete inside this window. Without it a hung endpoint
/// stalls the retry loop forever, because `fetch` has no default timeout.
const REQUEST_TIMEOUT_MS = 15_000;

/// A `0x`-prefixed hex string of arbitrary even length.
const hexString = z.string().regex(/^0x([0-9a-fA-F]{2})+$/, 'expected 0x-prefixed hex');
/// A decimal integer carried as a string, which is how the API returns u64/u128 values.
const numericString = z.string().regex(/^\d+$/, 'expected a decimal integer string');

const ecdsaSignatureSchema = z.object({
  fee: numericString,
  deadline: numericString,
  signature: hexString,
  cctpVersion: z.string().optional(),
});

const ed25519SignatureSchema = z.object({
  signature: hexString,
  message: hexString,
  publicKey: hexString,
  destinationDomain: numericString,
  fee: numericString,
  deadline: numericString,
});

const burnFeeSchema = z.array(z.object({
  finalityThreshold: z.number().int().nonnegative(),
  minimumFee: z.number().nonnegative(),
}));

/// Byte lengths mandated by the ed25519 scheme. A short buffer would otherwise reach the
/// Solana precompile instruction and fail there with an opaque error.
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;

/**
 * Rejects a quote endpoint that is not reachable over TLS.
 *
 * The gas API decides the fee, the deadline and (on Solana) the signed message itself, so
 * an attacker who can rewrite the response can redirect funds. Plain HTTP is only allowed
 * against loopback, which is where a local mock would run.
 */
function assertSafeBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid gasApiUrl: "${baseUrl}" is not a URL`);
  }
  const isLoopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error(
      `Refusing to use gasApiUrl "${baseUrl}": quote responses must be fetched over https`,
    );
  }
  // Strip a trailing slash so callers can pass either form without producing `//path`.
  return baseUrl.replace(/\/+$/, '');
}

async function fetchWithRetry<T>(
  url: string,
  schema: z.ZodType<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      // The response shape is enforced rather than asserted: everything downstream of
      // this point is used to build a fund-moving transaction.
      return schema.parse(await res.json());
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError!;
}

/// Decodes a validated `0x` hex string and asserts its byte length.
function decodeHex(value: string, expectedBytes: number | null, label: string): Buffer {
  const buf = Buffer.from(value.slice(2), 'hex');
  if (buf.length === 0) {
    throw new Error(`Gas API returned an empty ${label}`);
  }
  if (expectedBytes !== null && buf.length !== expectedBytes) {
    throw new Error(
      `Gas API returned a ${buf.length}-byte ${label}, expected ${expectedBytes} bytes`,
    );
  }
  return buf;
}

export class GasApiClient {
  private baseUrl: string;
  private irisUrl: string;

  constructor(baseUrl?: string, irisUrl?: string) {
    this.baseUrl = assertSafeBaseUrl(baseUrl ?? GAS_API_URL);
    this.irisUrl = assertSafeBaseUrl(irisUrl ?? IRIS_API_URL);
  }

  async getEcdsaSignature(
    localDomain: number,
    destinationDomain: number,
    isV2: boolean,
    isNative: boolean,
  ): Promise<{ fee: bigint; deadline: bigint; signature: `0x${string}` }> {
    const url = `${this.baseUrl}/getEcdsaSig_native?localDomain=${localDomain}&destinationDomain=${destinationDomain}&isNative=${isNative}&isV2=${isV2}`;
    const data = await fetchWithRetry(url, ecdsaSignatureSchema);
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
    const data = await fetchWithRetry(url, ed25519SignatureSchema);
    return {
      signature: decodeHex(data.signature, ED25519_SIGNATURE_BYTES, 'signature'),
      message: decodeHex(data.message, null, 'message'),
      publicKey: decodeHex(data.publicKey, ED25519_PUBLIC_KEY_BYTES, 'public key'),
      destinationDomain: parseInt(data.destinationDomain, 10),
      fee: data.fee,
      deadline: data.deadline,
    };
  }

  /**
   * Reads Circle's published minimum burn fee for a route at a given finality threshold.
   *
   * A missing threshold is an error rather than a fallback: silently substituting the
   * lowest tier would compute `maxFee` for a different finality than the
   * `minFinalityThreshold` actually submitted on-chain.
   */
  async getBurnFee(
    localDomain: number,
    destinationDomain: number,
    threshold: number,
  ): Promise<BurnFeeResponse> {
    const url = `${this.irisUrl}/v2/burn/USDC/fees/${localDomain}/${destinationDomain}`;
    const data = await fetchWithRetry(url, burnFeeSchema);

    const match = data.find(d => d.finalityThreshold === threshold);
    if (match) return match;

    if (data.length === 0) {
      throw new Error(`No burn fee data from Circle Iris for ${localDomain} -> ${destinationDomain}`);
    }

    throw new Error(
      `Circle Iris has no burn fee for finality threshold ${threshold} on ` +
      `${localDomain} -> ${destinationDomain}; available: ` +
      data.map(d => d.finalityThreshold).join(', '),
    );
  }
}
