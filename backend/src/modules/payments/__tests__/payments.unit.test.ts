// backend/src/modules/payments/__tests__/payments.unit.test.ts
//
// Pure financial-logic tests for the payments module: the authoritative fare
// breakdown, the no-show additional charge, settlement status inference and
// the Stripe environment interlock. Registered in run-tests.cjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFareBreakdown,
  FareBreakdownValidationError,
  computeFareBreakdownForRide,
} from '../fare-breakdown.service';
import { additionalChargeDueCents, settlementStatusFor } from '../ride-settlement.service';
import {
  stripeKeyIsLive,
  isStripeLiveAllowed,
  assertStripeUsable,
  isStripeConfigured,
  StripeNotConfiguredError,
  StripeLiveModeError,
} from '../stripe.client';
import { setStripeGatewayForTests, clearStripeGatewayForTests, getStripeGateway, type StripeGateway } from '../stripe.gateway';
import { env } from '../../../config/env';

// --- test allocation helpers ------------------------------------------------

const SIXTY_FORTY = {
  driverShareCents: 600,
  platformShareCents: 400,
  fleetShares: [],
  netrideShareCents: 400,
  driverSharePercent: 60,
  platformSharePercent: 40,
  fleetAllocationMap: {},
};

// --- 1. Authoritative fare breakdown ---------------------------------------

test('fare breakdown: $10 original, $5 sponsor subsidy → rider $5, driver 60% of ORIGINAL fare ($6)', () => {
  const b = computeFareBreakdown({
    originalFareCents: 1000,
    sponsorSubsidyCents: 500,
    allocation: SIXTY_FORTY,
  });
  assert.equal(b.originalFareCents, 1000);
  assert.equal(b.sponsorSubsidyCents, 500);
  assert.equal(b.riderShareCents, 500);
  // The invariant the whole task revolves around:
  assert.equal(b.driverEarningsCents, 600); // from 1000, NEVER from 500
  assert.equal(b.platformCommissionCents, 400);
  assert.equal(b.driverEarningsCents + b.platformCommissionCents, 1000);
});

test('fare breakdown: ordinary ride (no sponsor) keeps rider share = full fare', () => {
  const b = computeFareBreakdown({
    originalFareCents: 1000,
    allocation: SIXTY_FORTY,
  });
  assert.equal(b.riderShareCents, 1000);
  assert.equal(b.driverEarningsCents, 600);
  assert.equal(b.sponsorSubsidyCents, 0);
});

test('fare breakdown: promo + credits + sponsor cannot exceed the fare', () => {
  assert.throws(
    () =>
      computeFareBreakdown({
        originalFareCents: 1000,
        promoDiscountCents: 400,
        creditsAppliedCents: 400,
        sponsorSubsidyCents: 400,
        allocation: SIXTY_FORTY,
      }),
    FareBreakdownValidationError,
  );
});

test('fare breakdown: sponsor subsidy capped by the original fare', () => {
  assert.throws(
    () =>
      computeFareBreakdown({
        originalFareCents: 1000,
        sponsorSubsidyCents: 1500,
        allocation: SIXTY_FORTY,
      }),
    FareBreakdownValidationError,
  );
});

test('fare breakdown: negative components are rejected', () => {
  assert.throws(
    () =>
      computeFareBreakdown({
        originalFareCents: 1000,
        promoDiscountCents: -5,
        allocation: SIXTY_FORTY,
      }),
    FareBreakdownValidationError,
  );
});

test('fare breakdown: allocation that does not reconcile to the original fare is rejected', () => {
  assert.throws(
    () =>
      computeFareBreakdown({
        originalFareCents: 1000,
        allocation: { ...SIXTY_FORTY, driverShareCents: 700, platformShareCents: 100 },
      }),
    FareBreakdownValidationError,
  );
});

test('fare breakdown: cents rounding from a live split preserves exact reconciliation', async () => {
  // Input fares are already cents; computeFareBreakdownForRide only adds I/O
  // when no allocation is passed — this test exercises the pure branch.
  const b = computeFareBreakdown({
    originalFareCents: 1001,
    sponsorSubsidyCents: 100,
    allocation: {
      driverShareCents: 601,
      platformShareCents: 400,
      fleetShares: [],
      netrideShareCents: 400,
      driverSharePercent: 60,
      platformSharePercent: 40,
      fleetAllocationMap: {},
    },
  });
  assert.equal(b.riderShareCents, 901);
  assert.equal(b.driverEarningsCents, 601);
});

// --- 2. No-show additional charge ------------------------------------------

test('additional charge due: rider paid $5 of a $10 fare → $5 due', () => {
  assert.equal(additionalChargeDueCents({ originalFareCents: 1000, riderCollectedCents: 500 }), 500);
});

test('additional charge due: nothing collected → full fare', () => {
  assert.equal(additionalChargeDueCents({ originalFareCents: 1000, riderCollectedCents: 0 }), 1000);
});

test('additional charge due: rider already paid everything → 0 (never negative)', () => {
  assert.equal(additionalChargeDueCents({ originalFareCents: 1000, riderCollectedCents: 1000 }), 0);
  assert.equal(additionalChargeDueCents({ originalFareCents: 1000, riderCollectedCents: 1500 }), 0);
});

test('additional charge due: garbage input never goes below zero', () => {
  assert.equal(additionalChargeDueCents({ originalFareCents: -5, riderCollectedCents: NaN }), 0);
});

// --- 3. Settlement status inference ----------------------------------------

test('settlement status: fully collected ordinary ride → SETTLED', () => {
  assert.equal(
    settlementStatusFor({ requiredCents: 1000, collectedCents: 1000, sponsorPending: false, exception: false }),
    'SETTLED',
  );
});

test('settlement status: rider $5 + sponsor pending → PARTIALLY_SETTLED', () => {
  assert.equal(
    settlementStatusFor({ requiredCents: 1000, collectedCents: 500, sponsorPending: true, exception: false }),
    'PARTIALLY_SETTLED',
  );
});

test('settlement status: rider $5 + sponsor $5 collected → SETTLED', () => {
  assert.equal(
    settlementStatusFor({ requiredCents: 1000, collectedCents: 1000, sponsorPending: false, exception: false }),
    'SETTLED',
  );
});

test('settlement status: shortfall and no sponsor → EXCEPTION', () => {
  assert.equal(
    settlementStatusFor({ requiredCents: 1000, collectedCents: 300, sponsorPending: false, exception: true }),
    'EXCEPTION',
  );
});

// --- 4. Stripe environment interlock ---------------------------------------

test('stripe: live keys are detected and blocked outside production', () => {
  assert.equal(stripeKeyIsLive('sk_test_abc'), false);
  assert.equal(stripeKeyIsLive('sk_live_abc'), true);
  assert.equal(isStripeLiveAllowed(), false); // NODE_ENV is dev/test in the suite
});

test('stripe: unconfigured server throws a typed error, never fakes a payment', () => {
  if (isStripeConfigured()) return; // only asserted when no key is configured
  assert.throws(() => assertStripeUsable(), StripeNotConfiguredError);
});

test('stripe: a raw live key can never be used in this environment', () => {
  const original = env.STRIPE_SECRET_KEY;
  try {
    (env as any).STRIPE_SECRET_KEY = 'sk_live_fake123456789';
    assert.throws(() => assertStripeUsable(), StripeLiveModeError);
  } finally {
    (env as any).STRIPE_SECRET_KEY = original;
  }
});

test('stripe: refused test gateway installation in production', () => {
  const original = env.NODE_ENV;
  const fake: StripeGateway = {
    createOffSessionCharge: async () => ({ paymentIntentId: 'pi_test', status: 'succeeded', chargeId: null, failureReason: null, requiresAction: false }),
  } as unknown as StripeGateway;
  try {
    (env as any).NODE_ENV = 'production';
    assert.throws(() => setStripeGatewayForTests(fake), /Refusing to install a test Stripe gateway in production/);
  } finally {
    (env as any).NODE_ENV = original;
    clearStripeGatewayForTests();
  }
});

test('stripe: installed test gateway is served to services', () => {
  const fake: StripeGateway = {
    createOffSessionCharge: async () => ({ paymentIntentId: 'pi_fake', status: 'succeeded', chargeId: 'ch_fake', failureReason: null, requiresAction: false }),
  } as unknown as StripeGateway;
  try {
    setStripeGatewayForTests(fake);
    assert.equal(getStripeGateway(), fake);
  } finally {
    clearStripeGatewayForTests();
  }
});

test('fare breakdown: computeFareBreakdownForRide works with a provided allocation (no I/O)', async () => {
  const b = await computeFareBreakdownForRide({
    originalFareCents: 1000,
    sponsorSubsidyCents: 500,
    driverId: null,
    allocation: SIXTY_FORTY,
  });
  assert.equal(b.driverEarningsCents, 600);
  assert.equal(b.riderShareCents, 500);
});