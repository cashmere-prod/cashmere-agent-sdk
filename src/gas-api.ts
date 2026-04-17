import type { EcdsaSignatureResponse, Ed25519SignatureResponse, BurnFeeResponse } from './types';
import { GAS_API_URL } from './constants';

async function fetchWithRetry<T>(url: string, maxRetries = 3, baseDelay = 1000): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json() as T;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError!;
}

export class GasApiClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? GAS_API_URL;
  }

  async getEcdsaSignature(
    localDomain: number,
    destinationDomain: number,
    isV2: boolean,
    isNative: boolean,
  ): Promise<{ fee: bigint; deadline: bigint; signature: `0x${string}` }> {
    const url = `${this.baseUrl}/getEcdsaSig_native?localDomain=${localDomain}&destinationDomain=${destinationDomain}&isNative=${isNative}&isV2=${isV2}`;
    const data = await fetchWithRetry<EcdsaSignatureResponse>(url);
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
    const data = await fetchWithRetry<Ed25519SignatureResponse>(url);
    return {
      signature: Buffer.from(data.signature.slice(2), 'hex'),
      message: Buffer.from(data.message.slice(2), 'hex'),
      publicKey: Buffer.from(data.publicKey.slice(2), 'hex'),
      destinationDomain: parseInt(data.destinationDomain),
      fee: data.fee,
      deadline: data.deadline,
    };
  }

  async getBurnFee(
    localDomain: number,
    destinationDomain: number,
    threshold: number,
  ): Promise<BurnFeeResponse> {
    const url = `https://iris-api.circle.com/v2/burn/USDC/fees/${localDomain}/${destinationDomain}`;
    const data = await fetchWithRetry<Array<{ finalityThreshold: number; minimumFee: number }>>(url);

    const match = data.find(d => d.finalityThreshold === threshold);
    if (match) return match;

    if (data.length === 0) {
      throw new Error(`No burn fee data from Circle Iris for ${localDomain} -> ${destinationDomain}`);
    }

    const sorted = [...data].sort((a, b) => a.finalityThreshold - b.finalityThreshold);
    return sorted[0];
  }
}
