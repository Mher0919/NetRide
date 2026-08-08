// backend/src/modules/wallet/__tests__/wallet-cap.unit.test.ts
//
// Pure wallet-charge math. No DB, no server boot.

import { assert } from 'console';
import { computeWalletCharge } from '../wallet-cap';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ❌ ${name}`);
  }
}

// Wallet pays the full amount due up to balance.
{
  const r = computeWalletCharge(10000, 10000);
  check('full coverage: wallet pays everything', r.walletChargeCents === 10000 && r.finalCents === 0);
}
{
  const r = computeWalletCharge(11551, 20000);
  check('wallet covers more than due: charge only the due amount', r.walletChargeCents === 11551 && r.finalCents === 0);
}
{
  const r = computeWalletCharge(11551, 5000);
  check('partial coverage: wallet charged to balance, remainder owed', r.walletChargeCents === 5000 && r.finalCents === 6551);
}
{
  const r = computeWalletCharge(11551, 0);
  check('empty wallet: no charge, full amount owed', r.walletChargeCents === 0 && r.finalCents === 11551);
}
{
  const r = computeWalletCharge(0, 5000);
  check('no amount due: nothing charged', r.walletChargeCents === 0 && r.finalCents === 0);
}
{
  const r = computeWalletCharge(-100, 5000);
  check('negative due clamps to 0', r.walletChargeCents === 0 && r.finalCents === 0);
}
{
  const r = computeWalletCharge(Number.NaN, 5000);
  check('NaN due treated as 0', r.walletChargeCents === 0 && r.finalCents === 0);
}
{
  const r = computeWalletCharge(10000, Number.NaN);
  check('NaN balance treated as 0', r.walletChargeCents === 0 && r.finalCents === 10000);
}
{
  const r = computeWalletCharge(100.6, 50.4);
  check('cents rounded', r.walletChargeCents === 50 && r.finalCents === 51);
}

console.log(`\nwallet-cap.unit.test.ts → ${passed} passed, ${failed} failed`);
assert(failed === 0, 'wallet-cap unit tests must all pass');
