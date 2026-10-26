import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { USDC_ADDRESSES } from '../constants';
import { CashmereCCTP } from '../index';
import { getSolanaRecipientAndOwner, recipientError } from './address';

const EVM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const SOLANA_WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MOVE = `0x${'5a'.repeat(32)}`;

test('recipients in the destination chain format pass', () => {
  assert.equal(recipientError('base', EVM), undefined);
  assert.equal(recipientError('arbitrum', EVM.toLowerCase()), undefined);
  assert.equal(recipientError('arc', EVM), undefined);
  assert.equal(recipientError('solana', SOLANA_WALLET), undefined);
  assert.equal(recipientError('aptos', MOVE), undefined);
  assert.equal(recipientError('sui', MOVE), undefined);
});

test('another chain format is refused instead of being padded into an account nobody controls', () => {
  assert.match(recipientError('sui', EVM)!, /64 hex/);
  assert.match(recipientError('aptos', EVM)!, /64 hex/);
  assert.match(recipientError('ethereum', MOVE)!, /40 hex/);
  assert.match(recipientError('base', SOLANA_WALLET)!, /40 hex/);
  assert.match(recipientError('solana', EVM)!, /base58/);
  assert.match(recipientError('aptos', '0x1')!, /64 hex/);
  // An EVM address padded to 32 bytes looks like a Move address but belongs to nobody there
  assert.match(recipientError('sui', `0x${'0'.repeat(24)}${EVM.slice(2)}`)!, /EVM address padded to 32 bytes/);
  assert.match(recipientError('aptos', `0x${'0'.repeat(24)}${EVM.slice(2).toLowerCase()}`)!, /EVM address padded/);
});

test('mistyped or non-wallet recipients are refused', () => {
  // one letter's case flipped: the checksum no longer matches
  assert.match(recipientError('base', EVM.replace('aA', 'Aa'))!, /checksum/);
  assert.match(recipientError('base', `0x${'0'.repeat(40)}`)!, /zero address/);
  assert.match(recipientError('base', USDC_ADDRESSES.base!)!, /USDC token/);
  assert.match(recipientError('solana', USDC_ADDRESSES.solana!)!, /USDC token/);
  assert.match(recipientError('arc', USDC_ADDRESSES.arc!)!, /USDC token/);
  // the wallet's own USDC token account, which the SDK would wrap in another token account
  const ata = getSolanaRecipientAndOwner(SOLANA_WALLET).recipient;
  const ataBase58 = new PublicKey(Buffer.from(ata.slice(2), 'hex')).toBase58();
  assert.match(recipientError('solana', ataBase58)!, /wallet \(owner\) address/);
});

test('transfer() refuses a recipient in the wrong format before anything is signed', async () => {
  // A throwaway key, with hosts that cannot resolve: nothing could be sent even if the check let it through
  const cctp = new CashmereCCTP({
    evm: { privateKey: `0x${'ab'.repeat(32)}`, rpcUrl: 'https://rpc.invalid' },
    gasApiUrl: 'https://gas.invalid',
  });
  await assert.rejects(
    cctp.transfer({ from: 'base', to: 'sui', amount: '1', recipient: EVM }),
    /^Error: Invalid recipient: a sui recipient is a 0x address of 64 hex characters; an EVM address can't receive on sui$/,
  );
  await assert.rejects(
    cctp.transfer({ from: 'base', to: 'solana', amount: '1', recipient: USDC_ADDRESSES.solana! }),
    /Invalid recipient: the recipient is the USDC token itself/,
  );
});
