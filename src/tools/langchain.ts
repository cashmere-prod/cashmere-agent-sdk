import { Tool } from '@langchain/core/tools';
import type { CashmereCCTP } from '../index';
import { bridgeToolSchema } from '../tool-schema';

export class CashmereBridgeTool extends Tool {
  name = 'cashmere_bridge';
  description =
    `${bridgeToolSchema.description} Input is JSON: {"from":"ethereum","to":"arbitrum","amount":"100","recipient":"0x...","version":"v2-fast","feeMode":"native"}.`;

  private cctp: CashmereCCTP;

  constructor(cctp: CashmereCCTP) {
    super();
    this.cctp = cctp;
  }

  async _call(input: string): Promise<string> {
    const params = JSON.parse(input);
    const result = await this.cctp.transfer({
      from: params.from,
      to: params.to,
      amount: params.amount,
      recipient: params.recipient,
      version: params.version,
      feeMode: params.feeMode,
    });
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
    const params = JSON.parse(input);
    const result = await this.cctp.simulate({
      from: params.from,
      to: params.to,
      amount: params.amount,
      version: params.version,
      feeMode: params.feeMode,
    });
    return JSON.stringify(result);
  }
}

export function createBridgeTool(cctp: CashmereCCTP): CashmereBridgeTool {
  return new CashmereBridgeTool(cctp);
}

export function createSimulateTool(cctp: CashmereCCTP): CashmereSimulateTool {
  return new CashmereSimulateTool(cctp);
}
