import { Tool } from '@langchain/core/tools';
import type { CashmereCCTP } from '../index';
import type { Network, TransferParams } from '../types';
import { bridgeZodSchema, simulateZodSchema } from '../tool-schema';

/**
 * Guardrails applied to tool calls that move funds.
 *
 * Tool input arrives from a language model, so it is attacker-influenced whenever the
 * model reads untrusted text. These options let the host application bound the damage a
 * prompt-injected or hallucinating model can do, independently of the SDK's own checks.
 */
export interface BridgeToolOptions {
  /// Largest USDC amount, in human-readable units, the tool may bridge in one call.
  maxAmount?: string;
  /// Destination chains the tool is allowed to bridge to. Omit to allow all.
  allowedDestinations?: Network[];
  /// Recipient addresses the tool is allowed to send to. Compared case-insensitively.
  allowedRecipients?: string[];
  /**
   * Called before each transfer is submitted. Returning false (or a rejected promise)
   * aborts the call, which is how a human-in-the-loop confirmation is wired in.
   */
  confirm?: (params: TransferParams) => boolean | Promise<boolean>;
}

/// Parses tool input and reports a schema failure in a form a model can act on.
function parseToolInput<T>(input: string, schema: { parse: (v: unknown) => T }, tool: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new Error(`${tool}: input must be a JSON object, received: ${input}`);
  }
  try {
    return schema.parse(raw);
  } catch (err) {
    throw new Error(`${tool}: invalid arguments -- ${(err as Error).message}`);
  }
}

export class CashmereBridgeTool extends Tool {
  name = 'cashmere_bridge';
  description =
    'Bridge USDC across chains via Cashmere CCTP. Input is JSON: {"from":"ethereum","to":"arbitrum","amount":"100","recipient":"0x...","version":"v2-fast","feeMode":"native"}. Supports 16 chains: EVM (Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, Linea, Worldchain, Sei, Sonic, HyperEVM, Monad, Unichain), Solana, Aptos, Sui. Destination mint is automatic.';

  private cctp: CashmereCCTP;
  private options: BridgeToolOptions;

  constructor(cctp: CashmereCCTP, options: BridgeToolOptions = {}) {
    super();
    this.cctp = cctp;
    this.options = options;
  }

  async _call(input: string): Promise<string> {
    // The zod schema is enforced here rather than merely advertised to the model: without
    // it an out-of-enum chain reaches `CCTP_DOMAINS` as `undefined` and an arbitrary
    // recipient or amount reaches the signer.
    const params = parseToolInput(input, bridgeZodSchema, this.name);

    const { maxAmount, allowedDestinations, allowedRecipients, confirm } = this.options;

    if (maxAmount !== undefined && Number(params.amount) > Number(maxAmount)) {
      throw new Error(
        `${this.name}: refusing to bridge ${params.amount} USDC, which exceeds the ` +
        `configured per-call limit of ${maxAmount}`,
      );
    }

    if (allowedDestinations && !allowedDestinations.includes(params.to as Network)) {
      throw new Error(`${this.name}: destination "${params.to}" is not in the allowlist`);
    }

    if (
      allowedRecipients &&
      !allowedRecipients.some(a => a.toLowerCase() === params.recipient.toLowerCase())
    ) {
      throw new Error(`${this.name}: recipient "${params.recipient}" is not in the allowlist`);
    }

    const transferParams: TransferParams = {
      from: params.from as Network,
      to: params.to as Network,
      amount: params.amount,
      recipient: params.recipient,
      version: params.version,
      feeMode: params.feeMode,
      maxFee: params.maxFee,
    };

    if (confirm && !(await confirm(transferParams))) {
      throw new Error(`${this.name}: transfer was not confirmed`);
    }

    const result = await this.cctp.transfer(transferParams);
    return JSON.stringify(result);
  }
}

export class CashmereSimulateTool extends Tool {
  name = 'cashmere_simulate';
  description =
    'Simulate a USDC bridge transfer without executing. Input is JSON: {"from":"ethereum","to":"arbitrum","amount":"100"}. Returns estimated fee, duration, and route viability. Use before cashmere_bridge to preview costs.';

  private cctp: CashmereCCTP;

  constructor(cctp: CashmereCCTP) {
    super();
    this.cctp = cctp;
  }

  async _call(input: string): Promise<string> {
    const params = parseToolInput(input, simulateZodSchema, this.name);
    const result = await this.cctp.simulate({
      from: params.from as Network,
      to: params.to as Network,
      amount: params.amount,
      version: params.version,
      feeMode: params.feeMode,
    });
    return JSON.stringify(result);
  }
}

export function createBridgeTool(
  cctp: CashmereCCTP,
  options?: BridgeToolOptions,
): CashmereBridgeTool {
  return new CashmereBridgeTool(cctp, options);
}

export function createSimulateTool(cctp: CashmereCCTP): CashmereSimulateTool {
  return new CashmereSimulateTool(cctp);
}
