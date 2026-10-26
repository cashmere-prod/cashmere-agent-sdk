import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_NETWORKS } from '../constants';
import type { Network } from '../types';
import { getThreshold, isV2FastSupported, isV2Supported, resolveVersion } from './routing';

const MOVE: Network[] = ['aptos', 'sui'];

function routes(): [Network, Network][] {
  return ALL_NETWORKS.flatMap(from => ALL_NETWORKS.filter(to => to !== from).map(to => [from, to] as [Network, Network]));
}

test('every route to or from Aptos and Sui goes over CCTP V2', () => {
  for (const [from, to] of routes()) {
    if (!MOVE.includes(from) && !MOVE.includes(to)) continue;
    assert.ok(isV2Supported(from, to), `${from} -> ${to}`);
    assert.notEqual(resolveVersion(from, to), 'v1', `${from} -> ${to}`);
  }
});

test('transfers from Aptos and Sui use V2 Norm: Circle quotes no Fast fee from them', () => {
  for (const from of MOVE) {
    for (const to of ALL_NETWORKS.filter(n => n !== from)) {
      assert.equal(isV2FastSupported(from, to), false, `${from} -> ${to}`);
      assert.equal(resolveVersion(from, to), 'v2-norm', `${from} -> ${to}`);
      assert.equal(resolveVersion(from, to, 'v2-fast'), 'v2-norm', `${from} -> ${to} asked for v2-fast`);
    }
  }
});

test('transfers to Aptos and Sui use V2 Fast where the source has it, V2 Norm otherwise', () => {
  assert.equal(resolveVersion('base', 'aptos'), 'v2-fast');
  assert.equal(resolveVersion('ethereum', 'sui'), 'v2-fast');
  assert.equal(resolveVersion('base', 'sui', 'v2-norm'), 'v2-norm');
  assert.equal(resolveVersion('avalanche', 'aptos'), 'v2-norm');
  assert.equal(resolveVersion('solana', 'sui'), 'v2-norm');
});

test('V1 is not picked on a route that has V2, even when asked for', () => {
  for (const [from, to] of routes()) {
    assert.notEqual(resolveVersion(from, to, 'v1'), 'v1', `${from} -> ${to}`);
  }
});

test('finality thresholds', () => {
  assert.equal(getThreshold('v2-fast'), 1000);
  assert.equal(getThreshold('v2-norm'), 2000);
  assert.equal(getThreshold('v1'), 0);
});
