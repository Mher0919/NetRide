// backend/src/modules/payments/connect.service.ts
//
// STRIPE CONNECT — driver onboarding + payouts.
// ---------------------------------------------------------------------------
// Separate charges & transfers architecture:
//   * rider/sponsor charges land on the NetRide platform account;
//   * drivers get an Express connected account (Stripe-hosted onboarding —
//     NetRide never collects identity documents or bank details);
//   * NetRide pays drivers with Transfers sized from the driver's commission
//     share (always calculated from the ORIGINAL fare).
//
// Payout readiness is only ever taken from Stripe's live account state
// (`payouts_enabled`), never from "the driver finished onboarding".

import { pool } from '../../config/database';
import { tryGetStripeGateway, type StripeGateway } from './stripe.gateway';
import { isStripeConfigured } from './stripe.client';

function gatewayOrNull(): StripeGateway | null {
  return tryGetStripeGateway();
}

export interface DriverConnectStatus {
  configured: boolean;
  accountId: string | null;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  chargesEnabled: boolean;
  requirementsDue: string[];
  disabledReason: string | null;
  lastSyncedAt: Date | null;
  payoutReady: boolean;
}

export class ConnectService {
  static async getStatus(driverId: string): Promise<DriverConnectStatus> {
    const res = await pool.query(
      `SELECT stripe_account_id, details_submitted, payouts_enabled, charges_enabled,
              requirements_due, disabled_reason, last_synced_at
       FROM driver_stripe_accounts WHERE driver_id = $1`,
      [driverId],
    );
    const r = res.rows[0];
    return {
      configured: isStripeConfigured(),
      accountId: r?.stripe_account_id ?? null,
      detailsSubmitted: r?.details_submitted === true,
      payoutsEnabled: r?.payouts_enabled === true,
      chargesEnabled: r?.charges_enabled === true,
      requirementsDue: Array.isArray(r?.requirements_due) ? r.requirements_due : [],
      disabledReason: r?.disabled_reason ?? null,
      lastSyncedAt: r?.last_synced_at ?? null,
      payoutReady: r?.payouts_enabled === true,
    };
  }

  /** Creates (once) and returns the driver's Express account id. */
  static async ensureAccount(driverId: string): Promise<{ accountId: string }> {
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');

    const existing = await pool.query(
      `SELECT stripe_account_id FROM driver_stripe_accounts WHERE driver_id = $1`,
      [driverId],
    );
    if (existing.rows[0]?.stripe_account_id) {
      return { accountId: existing.rows[0].stripe_account_id };
    }

    const user = await pool.query(`SELECT email FROM users WHERE id = $1`, [driverId]);
    const { accountId } = await gateway.createExpressAccount({
      driverId,
      email: user.rows[0]?.email ?? null,
    });
    await pool.query(
      `INSERT INTO driver_stripe_accounts (driver_id, stripe_account_id)
       VALUES ($1, $2)
       ON CONFLICT (driver_id) DO NOTHING`,
      [driverId, accountId],
    );
    const row = await pool.query(
      `SELECT stripe_account_id FROM driver_stripe_accounts WHERE driver_id = $1`,
      [driverId],
    );
    return { accountId: row.rows[0]?.stripe_account_id ?? accountId };
  }

  /** Fresh Stripe-hosted onboarding link (single use, short lived). */
  static async createOnboardingLink(
    driverId: string,
    urls: { refreshUrl: string; returnUrl: string },
  ): Promise<{ url: string }> {
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');
    const { accountId } = await this.ensureAccount(driverId);
    const link = await gateway.createAccountLink({
      accountId,
      refreshUrl: urls.refreshUrl,
      returnUrl: urls.returnUrl,
    });
    return { url: link.url };
  }

  /** Pulls the authoritative account state from Stripe and persists it. */
  static async syncAccountStatus(driverId: string): Promise<DriverConnectStatus> {
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');
    const local = await pool.query(
      `SELECT stripe_account_id FROM driver_stripe_accounts WHERE driver_id = $1`,
      [driverId],
    );
    const accountId = local.rows[0]?.stripe_account_id;
    if (!accountId) throw new Error('Driver has no Stripe account yet');
    const account = await gateway.retrieveAccount(accountId);
    await this.applyAccountState(accountId, account);
    return this.getStatus(driverId);
  }

  /** Webhook path: account.updated. */
  static async applyAccountState(
    accountId: string,
    account: {
      detailsSubmitted: boolean;
      payoutsEnabled: boolean;
      chargesEnabled: boolean;
      requirementsDue: string[];
      disabledReason: string | null;
    },
  ): Promise<void> {
    await pool.query(
      `UPDATE driver_stripe_accounts
       SET details_submitted = $2, payouts_enabled = $3, charges_enabled = $4,
           requirements_due = $5::jsonb, disabled_reason = $6,
           last_synced_at = NOW(), updated_at = NOW()
       WHERE stripe_account_id = $1`,
      [
        accountId,
        account.detailsSubmitted,
        account.payoutsEnabled,
        account.chargesEnabled,
        JSON.stringify(account.requirementsDue ?? []),
        account.disabledReason ?? null,
      ],
    );
  }

  /**
   * Executes a real Stripe Transfer for a payout row. Refuses when the
   * account is not payout-ready according to Stripe. Idempotent per payout:
   * stored transfer id + Stripe idempotency key.
   */
  static async transferPayout(args: {
    payoutId: string;
    driverId: string;
    amountCents: number;
    description?: string;
  }): Promise<{ transferred: boolean; transferId?: string; reason?: string }> {
    const gateway = gatewayOrNull();
    if (!gateway) return { transferred: false, reason: 'stripe_unavailable' };

    const existing = await pool.query(
      `SELECT stripe_transfer_id FROM payouts WHERE id = $1`,
      [args.payoutId],
    );
    if (existing.rows[0]?.stripe_transfer_id) {
      return { transferred: true, transferId: existing.rows[0].stripe_transfer_id };
    }

    const status = await this.getStatus(args.driverId);
    if (!status.accountId) return { transferred: false, reason: 'no_connect_account' };

    // Re-verify with Stripe — local flags may be stale.
    const account = await gateway.retrieveAccount(status.accountId);
    await this.applyAccountState(status.accountId, account);
    if (!account.payoutsEnabled) {
      await pool.query(
        `UPDATE payouts SET stripe_transfer_status = 'BLOCKED', stripe_failure_reason = $2, updated_at = NOW()
         WHERE id = $1`,
        [args.payoutId, account.disabledReason ?? 'Driver payouts are not enabled'],
      ).catch(() => undefined);
      return { transferred: false, reason: 'payouts_not_enabled' };
    }

    try {
      const transfer = await gateway.createTransfer({
        amountCents: Math.round(args.amountCents),
        currency: 'usd',
        destination: status.accountId,
        description: args.description,
        metadata: { netride_payout_id: args.payoutId, netride_driver_id: args.driverId },
        idempotencyKey: `payout-transfer:${args.payoutId}`,
      });
      await pool.query(
        `UPDATE payouts
         SET stripe_transfer_id = $2, stripe_transfer_status = 'TRANSFERRED',
             stripe_failure_reason = NULL, processed_at = NOW(), reference = COALESCE(reference, $2)
         WHERE id = $1`,
        [args.payoutId, transfer.transferId],
      );
      return { transferred: true, transferId: transfer.transferId };
    } catch (err: any) {
      await pool.query(
        `UPDATE payouts
         SET stripe_transfer_status = 'FAILED', stripe_failure_reason = $2, updated_at = NOW()
         WHERE id = $1`,
        [args.payoutId, String(err?.message ?? 'transfer failed').slice(0, 300)],
      ).catch(() => undefined);
      return { transferred: false, reason: err?.message ?? 'transfer_failed' };
    }
  }

  /** Webhook path: transfer.failed / transfer.reversed. */
  static async applyTransferFailure(transferId: string, reason: string): Promise<void> {
    await pool.query(
      `UPDATE payouts
       SET stripe_transfer_status = 'FAILED', stripe_failure_reason = $2, updated_at = NOW()
       WHERE stripe_transfer_id = $1`,
      [transferId, reason.slice(0, 300)],
    );
  }

  static async applyTransferSuccess(transferId: string, stripePayoutId?: string | null): Promise<void> {
    await pool.query(
      `UPDATE payouts
       SET stripe_transfer_status = 'TRANSFERRED', stripe_failure_reason = NULL, updated_at = NOW()
       WHERE stripe_transfer_id = $1`,
      [transferId],
    );
    if (stripePayoutId) {
      await pool.query(
        `UPDATE payouts SET stripe_transfer_status = 'PAID_OUT', updated_at = NOW()
         WHERE stripe_transfer_id = $1`,
        [transferId],
      );
    }
  }
}
