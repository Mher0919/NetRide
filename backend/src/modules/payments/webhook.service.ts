// backend/src/modules/payments/webhook.service.ts
//
// STRIPE WEBHOOK PROCESSING
// ---------------------------------------------------------------------------
// * Signature is verified by Stripe's official library with the raw body
//   (see payments.routes.ts) before this service is reached.
// * Every event id is persisted first: duplicate/out-of-order deliveries are
//   skipped or applied idempotently. Handlers are small and safe to retry.
// * Local financial state is only advanced from a verified event (or an
//   explicit reconciliation read) — never from a client redirect.

import { pool } from '../../config/database';
import { PaymentsService } from './payments.service';
import { ConnectService } from './connect.service';
import { RideSettlementService } from './ride-settlement.service';
import { tryGetStripeGateway, type StripeWebhookEvent } from './stripe.gateway';

export type WebhookOutcome = 'processed' | 'skipped' | 'failed';

export class StripeWebhookService {
  static async handleEvent(event: StripeWebhookEvent): Promise<WebhookOutcome> {
    const claim = await pool.query(
      `INSERT INTO stripe_webhook_events (stripe_event_id, type, payload, status)
       VALUES ($1, $2, $3::jsonb, 'PROCESSING')
       ON CONFLICT (stripe_event_id) DO NOTHING
       RETURNING stripe_event_id`,
      [event.id, event.type, JSON.stringify(sanitizeEvent(event))],
    );
    if (claim.rows.length === 0) {
      return 'skipped'; // duplicate delivery
    }

    try {
      const outcome = await this.dispatch(event);
      await pool.query(
        `UPDATE stripe_webhook_events
         SET status = $2, processed_at = NOW()
         WHERE stripe_event_id = $1`,
        [event.id, outcome === 'processed' ? 'PROCESSED' : 'SKIPPED'],
      );
      return outcome;
    } catch (err: any) {
      await pool.query(
        `UPDATE stripe_webhook_events
         SET status = 'FAILED', error = $2, processed_at = NOW()
         WHERE stripe_event_id = $1`,
        [event.id, String(err?.message ?? 'webhook failed').slice(0, 500)],
      );
      // Re-throw so the route returns 500 and Stripe retries the delivery.
      throw err;
    }
  }

  private static async dispatch(event: StripeWebhookEvent): Promise<WebhookOutcome> {
    const object: any = event.data?.object ?? {};
    switch (event.type) {
      case 'checkout.session.completed': {
        const gateway = tryGetStripeGateway();
        if (!gateway) return 'skipped';
        // Re-read the session expanded so the handler works regardless of the
        // payload's expansion or API version skew.
        const session = await gateway.retrieveCheckoutSession(object.id);
        await PaymentsService.applyCheckoutSessionCompleted(session);
        return 'processed';
      }

      case 'setup_intent.succeeded': {
        const metadata = object.metadata ?? {};
        if (metadata.kind === 'SPONSOR_CARD_SETUP' && metadata.sponsor_id) {
          const gateway = tryGetStripeGateway();
          if (gateway) {
            const si = await gateway.retrieveSetupIntent(object.id);
            if (si.status === 'succeeded') {
              const card = si.paymentMethod;
              await pool.query(
                `UPDATE sponsors
                 SET stripe_customer_id = COALESCE($2, stripe_customer_id),
                     default_payment_method_id = $3,
                     card_brand = $4, card_last4 = $5,
                     card_exp_month = $6, card_exp_year = $7,
                     updated_payment_at = NOW(), updated_at = NOW()
                 WHERE id = $1`,
                [metadata.sponsor_id, si.customerId, si.paymentMethodId, card?.brand ?? null, card?.last4 ?? null, card?.expMonth ?? null, card?.expYear ?? null],
              );
            }
          }
          return 'processed';
        }
        if (metadata.kind === 'CARD_SETUP' && metadata.user_id) {
          const gateway = tryGetStripeGateway();
          if (gateway) {
            const si = await gateway.retrieveSetupIntent(object.id);
            if (si.status === 'succeeded') {
              const consent = metadata.off_session_consent === 'true';
              await pool.query(
                `UPDATE stripe_customers
                 SET default_payment_method_id = $2,
                     card_brand = $3, card_last4 = $4,
                     card_exp_month = $5, card_exp_year = $6,
                     off_session_consent = CASE WHEN $7 THEN TRUE ELSE off_session_consent END,
                     off_session_consent_at = CASE WHEN $7 THEN NOW() ELSE off_session_consent_at END,
                     updated_at = NOW()
                 WHERE user_id = $1`,
                [
                  metadata.user_id,
                  si.paymentMethodId,
                  si.paymentMethod?.brand ?? null,
                  si.paymentMethod?.last4 ?? null,
                  si.paymentMethod?.expMonth ?? null,
                  si.paymentMethod?.expYear ?? null,
                  consent,
                ],
              );
            }
          }
        }
        return 'processed';
      }

      case 'payment_intent.succeeded': {
        const metadata = object.metadata ?? {};
        const stripePaymentId = metadata.stripe_payment_id;
        if (stripePaymentId) {
          await pool.query(
            `UPDATE stripe_payments
             SET status = 'SUCCEEDED', stripe_charge_id = COALESCE(stripe_charge_id, $2),
                 succeeded_at = COALESCE(succeeded_at, NOW()), updated_at = NOW()
             WHERE id = $1 AND status NOT IN ('SUCCEEDED','REFUNDED')`,
            [stripePaymentId, object.latest_charge ?? null],
          );
          const row = await pool.query(`SELECT purpose FROM stripe_payments WHERE id = $1`, [stripePaymentId]);
          const purpose = row.rows[0]?.purpose as string | undefined;
          if (purpose === 'RIDER_WALLET_TOPUP') {
            await PaymentsService.applyRiderWalletTopup({ stripePaymentId, paymentIntentId: object.id });
          } else if (purpose === 'SPONSOR_BUDGET_TOPUP') {
            await PaymentsService.applySponsorBudgetTopup({ stripePaymentId, paymentIntentId: object.id });
          } else {
            await RideSettlementService.applyStripeChargeSucceeded({
              purpose: purpose ?? metadata.purpose ?? '',
              rideId: metadata.ride_id || null,
              amountCents: Number(object.amount_received ?? object.amount ?? 0),
              paymentIntentId: object.id ?? null,
            });
          }
        }
        return 'processed';
      }

      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        const metadata = object.metadata ?? {};
        const stripePaymentId = metadata.stripe_payment_id;
        if (stripePaymentId) {
          const status = event.type === 'payment_intent.canceled' ? 'CANCELED' : 'FAILED';
          await pool.query(
            `UPDATE stripe_payments
             SET status = $2,
                 failure_reason = COALESCE($3, failure_reason),
                 updated_at = NOW()
             WHERE id = $1 AND status NOT IN ('SUCCEEDED','REFUNDED')`,
            [
              stripePaymentId,
              status,
              object.last_payment_error?.message ?? object.cancellation_reason ?? event.type,
            ],
          );
          const row = await pool.query(`SELECT purpose FROM stripe_payments WHERE id = $1`, [stripePaymentId]);
          await RideSettlementService.applyStripeChargeFailed({
            purpose: (row.rows[0]?.purpose as string) ?? metadata.purpose ?? '',
            rideId: metadata.ride_id || null,
            failureReason: object.last_payment_error?.message ?? null,
          });
        }
        return 'processed';
      }

      case 'charge.refunded': {
        await pool.query(
          `UPDATE stripe_payments
           SET status = 'REFUNDED', updated_at = NOW()
           WHERE stripe_payment_intent_id = $1 AND status = 'SUCCEEDED'`,
          [typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id ?? null],
        );
        return 'processed';
      }

      case 'account.updated': {
        await ConnectService.applyAccountState(object.id, {
          detailsSubmitted: object.details_submitted === true,
          payoutsEnabled: object.payouts_enabled === true,
          chargesEnabled: object.charges_enabled === true,
          requirementsDue: object.requirements?.currently_due ?? [],
          disabledReason: object.requirements?.disabled_reason ?? null,
        });
        return 'processed';
      }

      case 'transfer.created':
      case 'transfer.updated': {
        await ConnectService.applyTransferSuccess(object.id);
        return 'processed';
      }

      case 'transfer.failed':
      case 'transfer.reversed': {
        await ConnectService.applyTransferFailure(object.id, event.type === 'transfer.reversed' ? 'Transfer reversed' : 'Transfer failed');
        return 'processed';
      }

      default:
        return 'skipped';
    }
  }
}

/** Keeps stored payloads useful without card data or oversized blobs. */
function sanitizeEvent(event: StripeWebhookEvent): Record<string, unknown> {
  const object: any = event.data?.object ?? {};
  return {
    id: event.id,
    type: event.type,
    object: {
      id: object.id,
      object: object.object,
      amount: object.amount,
      amount_received: object.amount_received,
      currency: object.currency,
      status: object.status,
      customer: typeof object.customer === 'string' ? object.customer : object.customer?.id,
      metadata: object.metadata,
      payment_intent: typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id,
    },
  };
}
