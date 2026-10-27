// The decode check: at least one refusal per rule on changed final bytes, the signed-message check, and no false refusal
// of a call the builders make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainSeparator, encodeFunctionData, type Abi, type Address, type Hex, type TypedDataDomain } from 'viem';
import { assertAutomationTx, checkAutomationTypedData, type GuardCtx, type TypedDataCtx } from './guard';
import {
  autoExitAbi, autoRangeAbi, gac3Abi, gac4Abi, gac4RefusedAbi, nftRefusedAbi, posmAbi, stewardAbi, stewardRefusedAbi,
} from './abis';
import {
  allowPosition, runNow, setExit, setRange, stopPlan, v3CompoundEnable, v3RangeEnable, v4CompoundEnable,
} from './calldata';
import {
  AUTO_EXIT_V3, AUTO_RANGE_V3, GOAT_AUTO_COMPOUND_V3, GOAT_AUTO_COMPOUND_V4, GOAT_V4_STEWARD, GOAT_V4_STEWARD_ENGINE, HORIZON_MAX_SEC, NPM, POSM,
  V3UTILS, V4UTILS,
} from './constants';
import { TARGETS } from './facts';
import { expectedDomainSeparator, nonceOf, permitTypedData, permitWord, sessionNonces, POSM_DOMAIN } from './permits';
import type { AutoCall } from './types';
import { FOREIGN_APP, GATES_OK, NOW_SEC, OTHER, P3, P4, RANGE_FEE_X64, SPENDERS, TEST_ACCOUNT, ctx, pool3, pool4 } from './__fixtures__/kit';

const ACCOUNT = TEST_ACCOUNT;

const okv = <T>(r: { ok: true; value: T } | { ok: false; errors: string[] }): T => { if (!r.ok) throw new Error(r.errors.join(' / ')); return r.value; };
const run = (to: Address, data: Hex, c: GuardCtx, value = 0n, chainId = 4663) => assertAutomationTx({ to, data, value, chainId }, c);
const rule = (v: ReturnType<typeof assertAutomationTx>) => (v.ok ? 'ok' : v.rule);
const enc = (abi: readonly unknown[], functionName: string, args: readonly unknown[]) => encodeFunctionData({ abi: abi as Abi, functionName, args: args as unknown[] });

const RANGE = okv(setRange({ tokenId: P4.id, draft: { kind: 'range', venue: 'v4', triggerTicks: 102, slippageBps: 50, minInterval: 21_600, maxSwapFeePips: 10_000 }, steward: GOAT_V4_STEWARD, pool: pool4, widthTicks: P4.tickUpper - P4.tickLower + 100 }));
const rangeArgs = RANGE.args[1] as Record<string, unknown>;
const RCTX = ctx('range', 'v4', { pool: { ...pool4, tickUpper: P4.tickUpper + 100 } });

test('the built range call passes', () => {
  assert.equal(rule(run(RANGE.to, RANGE.data, RCTX)), 'ok');
});

test('helper-contract: a helper contract of Revert Finance as the target or as an argument', () => {
  assert.equal(rule(run(V4UTILS, RANGE.data, RCTX)), 'helper-contract');
  assert.equal(rule(run(V3UTILS, RANGE.data, RCTX)), 'helper-contract');
  assert.equal(rule(run(POSM, enc(posmAbi, 'approve', [V4UTILS, P4.id]), RCTX)), 'helper-contract');
});

test('chain: wrong chain (the RPC or the request)', () => {
  assert.equal(rule(run(RANGE.to, RANGE.data, { ...RCTX, chainId: 1 })), 'chain');
  assert.equal(rule(run(RANGE.to, RANGE.data, RCTX, 0n, 8453)), 'chain');
});

test('target: an unknown target, the wrong position manager or the wrong contract for the venue', () => {
  assert.equal(rule(run(OTHER, RANGE.data, RCTX)), 'target');
  assert.equal(rule(run(NPM, enc(posmAbi, 'approve', [GOAT_V4_STEWARD_ENGINE, P4.id]), RCTX)), 'target');
  const c3 = okv(v3CompoundEnable({ tokenId: P3.id, draft: { kind: 'compound', venue: 'v3', swapEnabled: true, maxSlippageBps: 100, minInterval: 43_200 }, gac3: GOAT_AUTO_COMPOUND_V3 }));
  assert.equal(rule(run(c3.to, c3.data, ctx('compound', 'v4'))), 'target');
});

test('pinned-code: a contract whose live code does not match its pin is never used', () => {
  const bad = { ...GATES_OK, rangeExitV4: { ok: false, reason: 'GoatV4Steward does not match the build pinned in this package.' } };
  const v = run(RANGE.to, RANGE.data, { ...RCTX, gates: bad });
  assert.equal(rule(v), 'pinned-code');
  assert.ok(!v.ok && /does not match/.test(v.reason));
  // a stop of that automation is refused too
  const s = okv(stopPlan('range', 'v4', { tokenId: P4.id, targets: TARGETS, spenders: SPENDERS, approved: GOAT_V4_STEWARD_ENGINE }));
  assert.equal(rule(run(s[1].to, s[1].data, { ...RCTX, gates: bad, intent: 'stop', currentApproved: GOAT_V4_STEWARD_ENGINE })), 'pinned-code');
});

test('function: setApprovalForAll, permitForAll, transfers, keeper-only entry points, an unknown selector', () => {
  assert.equal(rule(run(POSM, enc(nftRefusedAbi, 'setApprovalForAll', [GOAT_V4_STEWARD_ENGINE, true]), RCTX)), 'function');
  assert.equal(rule(run(POSM, enc(nftRefusedAbi, 'permitForAll', [ACCOUNT, GOAT_V4_STEWARD_ENGINE, true, 1n, 1n, '0x']), RCTX)), 'function');
  assert.equal(rule(run(POSM, enc(nftRefusedAbi, 'transferFrom', [ACCOUNT, OTHER, P4.id]), RCTX)), 'function');
  assert.equal(rule(run(POSM, enc(posmAbi, 'permit', [GOAT_AUTO_COMPOUND_V4, P4.id, 1n, 1n, '0x']), RCTX)), 'function');
  assert.equal(rule(run(GOAT_V4_STEWARD, enc(stewardRefusedAbi, 'runWithPermit', [P4.id, 1n, { deadline: 1n, nonce: 1n, signature: '0x' }]), RCTX)), 'function');
  assert.equal(rule(run(GOAT_AUTO_COMPOUND_V4, enc(gac4RefusedAbi, 'execute', [{ tokenId: P4.id, deadline: 1n, permitDeadline: 1n, nonce: 1n, signature: '0x' }]), ctx('compound', 'v4'))), 'function');
  assert.equal(rule(run(RANGE.to, '0xdeadbeef', RCTX)), 'function');
  assert.equal(rule(run(NPM, enc(nftRefusedAbi, 'setApprovalForAll', [AUTO_RANGE_V3, true]), ctx('range', 'v3'))), 'function');
});

test('position: another position, the signer not the owner on chain (or not read), a different automation', () => {
  assert.equal(rule(run(RANGE.to, enc(stewardAbi, 'setRangeConfig', [P4.id + 1n, rangeArgs]), RCTX)), 'position');
  assert.equal(rule(run(RANGE.to, RANGE.data, { ...RCTX, ownerOnChain: OTHER })), 'position');
  assert.equal(rule(run(RANGE.to, RANGE.data, { ...RCTX, ownerOnChain: undefined })), 'position');
  assert.equal(rule(run(RANGE.to, RANGE.data, { ...ctx('exit', 'v4'), pool: RCTX.pool })), 'position', 'a range rule sent as an exit');
});

test("permission: a foreign spender, a permission in v4 auto-compound, approve(0) over another app's approval", () => {
  assert.equal(rule(run(POSM, enc(posmAbi, 'approve', [FOREIGN_APP, P4.id]), { ...RCTX, intent: 'allow' })), 'permission');
  assert.equal(rule(run(POSM, enc(posmAbi, 'approve', [GOAT_AUTO_COMPOUND_V4, P4.id]), { ...ctx('compound', 'v4'), intent: 'allow' })), 'permission');
  const zero = enc(posmAbi, 'approve', ['0x0000000000000000000000000000000000000000', P4.id]);
  assert.equal(rule(run(POSM, zero, { ...RCTX, intent: 'remove', currentApproved: FOREIGN_APP })), 'permission');
  assert.equal(rule(run(POSM, zero, { ...RCTX, intent: 'remove', currentApproved: GOAT_V4_STEWARD_ENGINE })), 'ok');
});

test('multicall: multicall with a nonce outside the session or the window, a foreign inner call, approve(0) of another id', () => {
  const allowed = [nonceOf(permitWord(GOAT_AUTO_COMPOUND_V4, P4.id), 0)];
  const base = { ...ctx('compound', 'v4'), intent: 'stop' as const, currentApproved: GOAT_AUTO_COMPOUND_V4, revokeAllowed: allowed };
  const mc = (inner: Hex[]) => enc(posmAbi, 'multicall', [inner]);
  assert.equal(rule(run(POSM, mc([enc(posmAbi, 'revokeNonce', [allowed[0]])]), base)), 'ok');
  assert.equal(rule(run(POSM, mc([enc(posmAbi, 'revokeNonce', [(9n << 8n) | 3n])]), base)), 'multicall');
  assert.equal(rule(run(POSM, mc([enc(posmAbi, 'revokeNonce', [7n << 8n])]), { ...base, revokeAllowed: [7n << 8n] })), 'multicall', 'an allowed nonce outside the window is still refused');
  assert.equal(rule(run(POSM, mc([enc(nftRefusedAbi, 'setApprovalForAll', [OTHER, true])]), base)), 'multicall');
  assert.equal(rule(run(POSM, mc([enc(posmAbi, 'approve', ['0x0000000000000000000000000000000000000000', P4.id + 1n])]), base)), 'multicall');
  assert.equal(rule(run(POSM, mc([enc(posmAbi, 'approve', [OTHER, P4.id])]), base)), 'multicall');
  assert.equal(rule(run(POSM, mc([enc(posmAbi, 'approve', ['0x0000000000000000000000000000000000000000', P4.id])]), { ...base, currentApproved: FOREIGN_APP })), 'multicall');
  assert.equal(rule(run(POSM, mc([]), base)), 'multicall');
});

test('rule-values: values changed after building fail the re-check', () => {
  assert.equal(rule(run(RANGE.to, enc(stewardAbi, 'setRangeConfig', [P4.id, { ...rangeArgs, triggerTicks: 101 }]), RCTX)), 'rule-values');
  assert.equal(rule(run(RANGE.to, enc(stewardAbi, 'setRangeConfig', [P4.id, { ...rangeArgs, slippageBps: 500 }]), RCTX)), 'rule-values');
  assert.equal(rule(run(RANGE.to, RANGE.data, { ...RCTX, pool: undefined })), 'rule-values', 'the pool facts must be read');
  const c3 = enc(gac3Abi, 'configToken', [P3.id, { enabled: true, swapEnabled: true, maxSlippageBps: 600, minInterval: 43_200, lastRunAt: 0, minReward0: 0n, minReward1: 0n }]);
  assert.equal(rule(run(GOAT_AUTO_COMPOUND_V3, c3, ctx('compound', 'v3'))), 'rule-values');
  const lastRun = enc(gac4Abi, 'configToken', [P4.id, { enabled: true, claimOnly: false, allowStandingApproval: false, maxSlippageBps: 100, minInterval: 43_200, lastRunAt: 5, minLiquidityDelta: 0n }]);
  assert.equal(rule(run(GOAT_AUTO_COMPOUND_V4, lastRun, ctx('compound', 'v4'))), 'rule-values');
  const v3w = enc(autoRangeAbi, 'configToken', [P3.id, '0x0000000000000000000000000000000000000000', { lowerTickLimit: 102, upperTickLimit: 102, lowerTickDelta: -195, upperTickDelta: 195, token0SlippageX64: 1n << 56n, token1SlippageX64: 1n << 56n, onlyFees: false, autoCompound: false, maxRewardX64: RANGE_FEE_X64 }]);
  assert.equal(rule(run(AUTO_RANGE_V3, v3w, ctx('range', 'v3'))), 'rule-values', 'width 390 < 420');
  const vault = enc(autoRangeAbi, 'configToken', [P3.id, OTHER, { lowerTickLimit: 102, upperTickLimit: 102, lowerTickDelta: -300, upperTickDelta: 300, token0SlippageX64: 1n << 56n, token1SlippageX64: 1n << 56n, onlyFees: false, autoCompound: false, maxRewardX64: RANGE_FEE_X64 }]);
  assert.equal(rule(run(AUTO_RANGE_V3, vault, ctx('range', 'v3'))), 'rule-values', 'the vault must be zero');
});

test('rule-limits: the permission for all positions, more than 20 moves, exit flag 16, fee-only modes, a fee above the live fee', () => {
  assert.equal(rule(run(RANGE.to, enc(stewardAbi, 'setRangeConfig', [P4.id, { ...rangeArgs, standing: true }]), RCTX)), 'rule-limits');
  assert.equal(rule(run(RANGE.to, enc(stewardAbi, 'setRangeConfig', [P4.id, { ...rangeArgs, budget: 21 }]), RCTX)), 'rule-limits');
  const ex = okv(setExit({ tokenId: P4.id, draft: { kind: 'exit', venue: 'v4', lower: { on: true, tick: P4.tickLower - 500, swap: false }, upper: { on: false, tick: 0, swap: false }, slippageBps: 50, maxSwapFeePips: 0 }, steward: GOAT_V4_STEWARD, pool: pool4, tickLower: P4.tickLower, tickUpper: P4.tickUpper, swapAllowed: true }));
  const exArgs = ex.args[1] as Record<string, unknown>;
  assert.equal(rule(run(ex.to, ex.data, ctx('exit', 'v4'))), 'ok');
  assert.equal(rule(run(ex.to, enc(stewardAbi, 'setExitConfig', [P4.id, { ...exArgs, flags: 1 | 16 }]), ctx('exit', 'v4'))), 'rule-limits');
  const ar = (o: Record<string, unknown>) => enc(autoRangeAbi, 'configToken', [P3.id, '0x0000000000000000000000000000000000000000', { lowerTickLimit: 102, upperTickLimit: 102, lowerTickDelta: -240, upperTickDelta: 240, token0SlippageX64: 1n << 56n, token1SlippageX64: 1n << 56n, onlyFees: false, autoCompound: false, maxRewardX64: RANGE_FEE_X64, ...o }]);
  assert.equal(rule(run(AUTO_RANGE_V3, ar({}), ctx('range', 'v3'))), 'ok');
  assert.equal(rule(run(AUTO_RANGE_V3, ar({ onlyFees: true }), ctx('range', 'v3'))), 'rule-limits');
  assert.equal(rule(run(AUTO_RANGE_V3, ar({ autoCompound: true }), ctx('range', 'v3'))), 'rule-limits');
  assert.equal(rule(run(AUTO_RANGE_V3, ar({ maxRewardX64: RANGE_FEE_X64 + 1n }), ctx('range', 'v3'))), 'rule-limits');
  const ae = enc(autoExitAbi, 'configToken', [P3.id, { isActive: true, token0Swap: false, token1Swap: false, token0TriggerTick: P3.tickLower - 500, token1TriggerTick: 887273, token0SlippageX64: 1n << 56n, token1SlippageX64: 1n << 56n, onlyFees: true, maxRewardX64: RANGE_FEE_X64 }]);
  assert.equal(rule(run(AUTO_EXIT_V3, ae, ctx('exit', 'v3'))), 'rule-limits');
  const standing = enc(gac4Abi, 'configToken', [P4.id, { enabled: true, claimOnly: false, allowStandingApproval: true, maxSlippageBps: 100, minInterval: 43_200, lastRunAt: 0, minLiquidityDelta: 0n }]);
  assert.equal(rule(run(GOAT_AUTO_COMPOUND_V4, standing, ctx('compound', 'v4'))), 'rule-limits', 'the per-run approval mode is never used');
});

test('fee-recipient: a fee recipient that is not the treasury (turn on and allow), or one not read', () => {
  assert.equal(rule(run(RANGE.to, RANGE.data, { ...RCTX, treasuryOk: { rangeExitV4: false } })), 'fee-recipient');
  assert.equal(rule(run(RANGE.to, RANGE.data, { ...RCTX, treasuryOk: {} })), 'fee-recipient', 'not read = refused');
  const a = okv(allowPosition({ kind: 'range', venue: 'v4', tokenId: P4.id, spenders: SPENDERS }));
  assert.equal(rule(run(a.to, a.data, { ...RCTX, intent: 'allow', treasuryOk: {} })), 'fee-recipient');
  const c4 = okv(v4CompoundEnable({ tokenId: P4.id, draft: { kind: 'compound', venue: 'v4', mode: 'addBack', maxSlippageBps: 100, minInterval: 43_200, runsToSign: 12, horizonDays: 30 }, gac4: GOAT_AUTO_COMPOUND_V4 }));
  assert.equal(rule(run(c4.to, c4.data, ctx('compound', 'v4', { treasuryOk: { autoCompoundV4: false } }))), 'fee-recipient');
});

test('one-automation: one automation per position; an unread rule slot refuses every turn-on', () => {
  assert.equal(rule(run(RANGE.to, RANGE.data, { ...RCTX, activeKinds: ['compound'] })), 'one-automation');
  const a = okv(allowPosition({ kind: 'range', venue: 'v4', tokenId: P4.id, spenders: SPENDERS }));
  assert.equal(rule(run(a.to, a.data, { ...RCTX, intent: 'allow', activeKinds: ['exit'] })), 'one-automation');
  assert.equal(rule(run(RANGE.to, RANGE.data, { ...RCTX, activeKinds: 'unknown' })), 'one-automation');
  assert.equal(rule(run(RANGE.to, RANGE.data, { ...RCTX, activeKinds: ['range'] })), 'ok', 'changing the same kind');
  // v3: one approved address per token, so a second automation is refused
  const a3 = okv(allowPosition({ kind: 'exit', venue: 'v3', tokenId: P3.id, spenders: SPENDERS }));
  assert.equal(rule(run(a3.to, a3.data, { ...ctx('exit', 'v3'), intent: 'allow', activeKinds: ['compound'] })), 'one-automation');
});

test('run-deadline: a run deadline beyond 5 minutes or in the past; a stale simulation', () => {
  const r = runNow({ tokenId: P4.id, steward: GOAT_V4_STEWARD, nowSec: NOW_SEC });
  const fresh = { ...RCTX, intent: 'run' as const, simulatedOkAtMs: NOW_SEC * 1000, nowMs: NOW_SEC * 1000 + 1000 };
  assert.equal(rule(run(r.to, r.data, fresh)), 'ok');
  assert.equal(rule(run(r.to, enc(stewardAbi, 'run', [P4.id, BigInt(NOW_SEC + 301)]), fresh)), 'run-deadline');
  assert.equal(rule(run(r.to, enc(stewardAbi, 'run', [P4.id, BigInt(NOW_SEC)]), fresh)), 'run-deadline');
  assert.equal(rule(run(r.to, r.data, { ...fresh, nowMs: NOW_SEC * 1000 + 31_000 })), 'run-deadline');
});

test('no-value: any value is refused', () => {
  assert.equal(rule(run(RANGE.to, RANGE.data, RCTX, 1n)), 'no-value');
});

test('every call the builders make for a turn-on passes (no false refusals)', () => {
  const calls: [AutoCall, GuardCtx][] = [
    [RANGE, RCTX],
    [okv(v3RangeEnable({ tokenId: P3.id, draft: { kind: 'range', venue: 'v3', triggerTicks: 102, widthTicks: 480, slippageBps: 50 }, autoRange: AUTO_RANGE_V3, gate: 101, tickSpacing: 60, rangeFeeX64: RANGE_FEE_X64 })), ctx('range', 'v3')],
    [okv(allowPosition({ kind: 'range', venue: 'v3', tokenId: P3.id, spenders: SPENDERS })), ctx('range', 'v3', { intent: 'allow' })],
    [okv(allowPosition({ kind: 'compound', venue: 'v3', tokenId: P3.id, spenders: SPENDERS })), ctx('compound', 'v3', { intent: 'allow' })],
  ];
  for (const [c, x] of calls) { const v = run(c.to, c.data, x); assert.equal(rule(v), 'ok', `${c.functionName}: ${v.ok ? '' : v.reason}`); }
});

// ------------------------------------------------------------------ the signed messages of v4 auto-compound

const GAC4 = GOAT_AUTO_COMPOUND_V4;
const ID = P4.id;
const SEP = expectedDomainSeparator();
const WORD = permitWord(GAC4, ID);
const tdCtx = (over: Partial<TypedDataCtx> = {}): TypedDataCtx => ({
  chainId: 4663, gac4: GAC4, tokenId: ID, allowedNonces: sessionNonces(WORD, 4), onchainDomainSeparator: SEP, nowSec: NOW_SEC, gac4Target: GAC4, gateOk: true, ownerOk: true, ...over,
});
const td = (over: { nonce?: bigint; deadline?: bigint; spender?: Address; tokenId?: bigint } = {}) => permitTypedData({
  spender: over.spender ?? GAC4, tokenId: over.tokenId ?? ID, nonce: over.nonce ?? nonceOf(WORD, 0), deadline: over.deadline ?? BigInt(NOW_SEC + 30 * 86_400),
});
const trule = (c: ReturnType<typeof checkAutomationTypedData>) => (c.ok ? 'ok' : c.rule);

test('signed-message: the domain is the v4 position NFT on 4663, no version, equal to the on-chain separator', () => {
  assert.deepEqual(POSM_DOMAIN, { name: 'Uniswap v4 Positions NFT', chainId: 4663, verifyingContract: POSM });
  assert.equal(SEP, domainSeparator({ domain: { name: 'Uniswap v4 Positions NFT', chainId: 4663, verifyingContract: POSM } as TypedDataDomain }));
  assert.equal(SEP, '0x061938567e6832ca43b380ce1978347d2ab5aea073ca93cdf29074c9ebfa15dd', 'the separator the position NFT reports on Robinhood Chain');
  assert.equal(trule(checkAutomationTypedData(td(), tdCtx())), 'ok');
});

test('signed-message: every refusal of a signed message', () => {
  assert.equal(trule(checkAutomationTypedData(td(), tdCtx({ onchainDomainSeparator: `0x${'00'.repeat(32)}` as Hex }))), 'signed-message', 'on-chain separator differs');
  assert.equal(trule(checkAutomationTypedData(td(), tdCtx({ onchainDomainSeparator: undefined }))), 'signed-message', 'separator not read');
  assert.equal(trule(checkAutomationTypedData({ ...td(), domain: { ...POSM_DOMAIN, chainId: 1 } }, tdCtx())), 'signed-message');
  assert.equal(trule(checkAutomationTypedData({ ...td(), domain: { ...POSM_DOMAIN, verifyingContract: GOAT_V4_STEWARD_ENGINE } }, tdCtx())), 'signed-message');
  assert.equal(trule(checkAutomationTypedData({ ...td(), domain: { ...POSM_DOMAIN, version: '1' } as never }, tdCtx())), 'signed-message', 'extra domain field');
  assert.equal(trule(checkAutomationTypedData({ ...td(), primaryType: 'PermitForAll' }, tdCtx())), 'signed-message');
  assert.equal(trule(checkAutomationTypedData({ ...td(), types: { Permit: [{ name: 'spender', type: 'address' }] } }, tdCtx())), 'signed-message');
  assert.equal(trule(checkAutomationTypedData(td({ spender: GOAT_V4_STEWARD_ENGINE }), tdCtx())), 'signed-message', 'only spender GoatAutoCompoundV4');
  assert.equal(trule(checkAutomationTypedData(td(), tdCtx({ gac4Target: GOAT_V4_STEWARD_ENGINE }))), 'signed-message');
  assert.equal(trule(checkAutomationTypedData(td({ tokenId: ID + 1n }), tdCtx())), 'signed-message', 'another position');
  assert.equal(trule(checkAutomationTypedData(td({ nonce: nonceOf(WORD, 4) }), tdCtx())), 'signed-message', 'nonce outside the session');
  assert.equal(trule(checkAutomationTypedData(td({ nonce: nonceOf(6n, 0) }), tdCtx({ allowedNonces: [nonceOf(6n, 0)] }))), 'signed-message', 'a word outside the window');
  assert.equal(trule(checkAutomationTypedData(td({ deadline: BigInt(NOW_SEC) }), tdCtx())), 'signed-message', 'deadline now');
  assert.equal(trule(checkAutomationTypedData(td({ deadline: BigInt(NOW_SEC + HORIZON_MAX_SEC) }), tdCtx())), 'ok', '90 days exactly');
  assert.equal(trule(checkAutomationTypedData(td({ deadline: BigInt(NOW_SEC + HORIZON_MAX_SEC + 1) }), tdCtx())), 'signed-message', 'beyond 90 days');
  assert.equal(trule(checkAutomationTypedData(td(), tdCtx({ chainId: 8453 }))), 'chain');
  assert.equal(trule(checkAutomationTypedData(td(), tdCtx({ gateOk: false }))), 'pinned-code');
  assert.equal(trule(checkAutomationTypedData(td(), tdCtx({ ownerOk: false }))), 'position', 'only a position the signer owns');
});
