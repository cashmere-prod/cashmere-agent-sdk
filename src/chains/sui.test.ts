import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import {
  SUI_CASHMERE_CONFIG,
  SUI_CASHMERE_PACKAGE,
  SUI_CASHMERE_PACKAGE_V2,
  SUI_DEFAULT_GRPC,
  SUI_MT_STATE,
  SUI_MT_V2_STATE,
  SUI_TMM_PACKAGE,
  SUI_TMM_V2_PACKAGE,
  SUI_TMM_V2_STATE,
  SUI_USDC_HANDLER_PACKAGE,
  SUI_USDC_HANDLER_STATE,
  SUI_USDC_TREASURY,
  SUI_USDC_TYPE,
} from '../constants';
import { buildSuiTransferTx } from './sui';

const params = {
  sender: `0x${'22'.repeat(32)}`,
  dstDomain: 6,
  amount: 1_000_000n,
  recipient: `0x${'11'.repeat(32)}`,
  solanaOwner: `0x${'00'.repeat(32)}`,
  isNative: false,
  fee: '190000',
  deadline: '1793005550',
  signature: new Uint8Array(64).fill(7),
};
const v2 = { maxFee: 0n, minFinalityThreshold: 2000 };

type Arg = { $kind: string; Input?: number; NestedResult?: [number, number] };

function inspect(tx: ReturnType<typeof buildSuiTransferTx>) {
  const data = tx.getData();
  const calls = data.commands.flatMap((command, index) => command.MoveCall ? [{ index, ...command.MoveCall }] : []);
  const objectId = (arg: Arg) => {
    const input = data.inputs[arg.Input!];
    return input.UnresolvedObject?.objectId;
  };
  return { calls, objectId };
}

const target = (call: { package: string; module: string; function: string }) => `${call.package}::${call.module}::${call.function}`;

test('V2: Cashmere ticket, TMM V2 receipt, USDC handler burn, complete_burn', () => {
  const { calls, objectId } = inspect(buildSuiTransferTx({ ...params, v2 }));
  assert.deepEqual(calls.map(target), [
    `${SUI_CASHMERE_PACKAGE_V2}::transfer::prepare_deposit_for_burn_v2`,
    `${SUI_TMM_V2_PACKAGE}::deposit_for_burn::deposit_for_burn_with_package_auth`,
    `${SUI_USDC_HANDLER_PACKAGE}::handler::burn`,
    `${SUI_TMM_V2_PACKAGE}::deposit_for_burn::complete_burn`,
  ]);
  const [prepare, deposit, burn, complete] = calls;

  assert.deepEqual(prepare.typeArguments, []);
  assert.equal(prepare.arguments.length, 14);
  assert.equal(objectId(prepare.arguments[12] as Arg), SUI_CASHMERE_CONFIG);

  // the Auth witness type keeps the original package id
  assert.deepEqual(deposit.typeArguments, [SUI_USDC_TYPE, `${SUI_CASHMERE_PACKAGE}::transfer::Auth`]);
  assert.deepEqual(deposit.arguments[0], { $kind: 'NestedResult', NestedResult: [prepare.index, 0] });
  assert.equal(objectId(deposit.arguments[1] as Arg), SUI_TMM_V2_STATE);

  assert.equal(objectId(burn.arguments[0] as Arg), SUI_USDC_HANDLER_STATE);
  assert.deepEqual(burn.arguments[1], { $kind: 'NestedResult', NestedResult: [deposit.index, 0] });
  assert.deepEqual(burn.arguments[2], { $kind: 'NestedResult', NestedResult: [deposit.index, 1] });
  assert.equal(objectId(burn.arguments[3] as Arg), normalizeSuiAddress('0x403'));
  assert.equal(objectId(burn.arguments[4] as Arg), SUI_USDC_TREASURY);

  assert.deepEqual(complete.typeArguments, [SUI_USDC_TYPE, `${SUI_USDC_HANDLER_PACKAGE}::handler::Auth`]);
  assert.deepEqual(complete.arguments[0], { $kind: 'NestedResult', NestedResult: [burn.index, 0] });
  assert.equal(objectId(complete.arguments[1] as Arg), SUI_TMM_V2_STATE);
  assert.equal(objectId(complete.arguments[2] as Arg), SUI_MT_V2_STATE);
});

test('V1 keeps the ticket, V1 burn and post-burn calls', () => {
  const { calls, objectId } = inspect(buildSuiTransferTx(params));
  assert.deepEqual(calls.map(target), [
    `${SUI_CASHMERE_PACKAGE}::transfer::prepare_deposit_for_burn_ticket`,
    `${SUI_TMM_PACKAGE}::deposit_for_burn::deposit_for_burn_with_package_auth`,
    `${SUI_CASHMERE_PACKAGE}::transfer::post_deposit_for_burn`,
  ]);
  assert.equal(objectId(calls[1].arguments[2] as Arg), SUI_MT_STATE);
});

// Compares every V2 call with its function on mainnet: argument and type argument counts
test('V2 calls match the on-chain functions', { skip: !process.env.CASHMERE_LIVE && 'set CASHMERE_LIVE=1' }, async () => {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const client = new SuiGrpcClient({ network: 'mainnet', baseUrl: SUI_DEFAULT_GRPC });
  const { calls } = inspect(buildSuiTransferTx({ ...params, v2 }));
  for (const call of calls) {
    const { function: fn } = await client.core.getMoveFunction({ packageId: call.package, moduleName: call.module, name: call.function });
    const explicit = fn.parameters.filter(p => !(p.body.$kind === 'datatype' && p.body.datatype.typeName.endsWith('::tx_context::TxContext')));
    assert.equal(call.arguments.length, explicit.length, `${target(call)} arguments`);
    assert.equal(call.typeArguments.length, fn.typeParameters.length, `${target(call)} type arguments`);
  }
});
