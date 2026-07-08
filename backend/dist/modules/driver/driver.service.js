"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DriverService = void 0;
const database_1 = require("../../config/database");
const email_service_1 = require("../../services/email.service");
const prisma_service_1 = require("../../services/prisma.service");
const redis_1 = require("../../config/redis");
const env_1 = require("../../config/env");
const card_1 = require("../../utils/card");
class DriverService {
    static async getProfile(userId) {
        const res = await database_1.pool.query(`SELECT u.*, d.*
       FROM users u
       LEFT JOIN drivers d ON u.id = d.user_id
       WHERE u.id = $1`, [userId]);
        const profile = res.rows[0];
        if (profile && profile.user_id) {
            const vehicleRes = await database_1.pool.query(`SELECT dv.*, v.*
         FROM driver_vehicles dv
         JOIN vehicles v ON dv.vehicle_id = v.id
         WHERE dv.driver_id = $1`, [userId]);
            profile.vehicles = vehicleRes.rows;
        }
        // Surface any pending profile change so the driver app can render the
        // red banner without an extra round-trip.
        try {
            const pending = await database_1.pool.query(`SELECT id, requested_changes, created_at, card_last4, card_brand
         FROM profile_change_requests
         WHERE driver_id = $1 AND status = 'PENDING'
         ORDER BY created_at DESC
         LIMIT 1`, [userId]);
            if (pending.rowCount && pending.rowCount > 0) {
                const row = pending.rows[0];
                const changes = row.requested_changes ?? {};
                profile.has_pending_profile_change = true;
                profile.pending_request_id = row.id;
                profile.pending_requested_at = row.created_at;
                profile.pending_card_last4 = row.card_last4;
                profile.pending_card_brand = row.card_brand;
                profile.pending_changes_summary = Object.keys(changes).filter(k => k !== 'payout_card');
            }
            else {
                profile.has_pending_profile_change = false;
            }
        }
        catch (_err) {
            // Table may not exist yet on first boot; treat as no pending change.
            profile.has_pending_profile_change = false;
        }
        return profile;
    }
    static async onboard(userId, data) {
        const client = await database_1.pool.connect();
        try {
            await client.query('BEGIN');
            // Validation: Ensure mandatory fields are present
            if (!data.personalInfo.profile_image_url)
                throw new Error('Profile picture is mandatory');
            if (!data.identity.license_photo_url || !data.identity.license_photo_back_url) {
                throw new Error('Both front and back photos of the license are mandatory');
            }
            if (!data.identity.insurance_photo_url || !data.identity.registration_photo_url) {
                throw new Error('Insurance and car registration photos are mandatory');
            }
            if (!data.vehicle.inspection_photo_url) {
                throw new Error('Vehicle inspection certificate is mandatory for registration');
            }
            // Vehicle Year Validation (2011 -> Present)
            const vehicleYear = parseInt(data.vehicle.year);
            if (isNaN(vehicleYear) || vehicleYear < 2011) {
                throw new Error('Vehicle year must be 2011 or newer to register on NetRide.');
            }
            // Custom-vehicle fallback: when vehicle_id is missing, make/model/color are required
            if (!data.vehicle.vehicle_id) {
                const missing = [];
                if (!data.vehicle.make || !String(data.vehicle.make).trim())
                    missing.push('make');
                if (!data.vehicle.model || !String(data.vehicle.model).trim())
                    missing.push('model');
                if (!data.vehicle.color || !String(data.vehicle.color).trim())
                    missing.push('color');
                if (missing.length > 0) {
                    throw new Error(`Custom vehicle is missing required field(s): ${missing.join(', ')}.`);
                }
            }
            // 1. Update User
            await client.query(`UPDATE users 
         SET phone_number = $1, date_of_birth = $2, profile_image_url = $3, updated_at = NOW() 
         WHERE id = $4`, [data.personalInfo.phone_number, data.personalInfo.date_of_birth, data.personalInfo.profile_image_url, userId]);
            // 2. Ensure Driver Record Exists and Update
            const driverExists = await client.query('SELECT * FROM drivers WHERE user_id = $1', [userId]);
            if (driverExists.rows.length === 0) {
                await client.query('INSERT INTO drivers (user_id) VALUES ($1)', [userId]);
            }
            const driverRes = await client.query(`UPDATE drivers 
         SET license_number = $1, license_expiry_date = $2, 
             license_photo_url = $3, license_photo_back_url = $4,
             insurance_photo_url = $5, registration_photo_url = $6,
             background_check_status = 'PENDING', is_active = false 
         WHERE user_id = $7
         RETURNING *`, [
                data.identity.license_number,
                data.identity.license_expiry_date,
                data.identity.license_photo_url,
                data.identity.license_photo_back_url,
                data.identity.insurance_photo_url,
                data.identity.registration_photo_url,
                userId
            ]);
            // 3. Create DriverVehicle
            await client.query(`INSERT INTO driver_vehicles (
          driver_id, vehicle_id, license_plate_number, license_plate_photo_url,
          car_photo_urls, color, interior_color, make, model, year,
          inspection_photo_url, inspection_status
        )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING')`, [
                userId,
                data.vehicle.vehicle_id ?? null,
                data.vehicle.license_plate_number,
                data.vehicle.license_plate_photo_url ?? null,
                data.vehicle.car_photo_urls,
                data.vehicle.color,
                data.vehicle.interior_color,
                data.vehicle.make,
                data.vehicle.model,
                data.vehicle.year,
                data.vehicle.inspection_photo_url
            ]);
            await client.query('COMMIT');
            // 4. Trigger Email Notice to Admin
            const userRes = await database_1.pool.query('SELECT email FROM users WHERE id = $1', [userId]);
            email_service_1.EmailService.sendDriverRegistrationNotice({
                personalInfo: {
                    userId,
                    full_name: data.personalInfo.full_name,
                    email: userRes.rows[0]?.email,
                    phone_number: data.personalInfo.phone_number,
                    date_of_birth: data.personalInfo.date_of_birth,
                    profile_image_url: data.personalInfo.profile_image_url,
                },
                identity: data.identity,
                vehicle: data.vehicle,
            });
            return driverRes.rows[0];
        }
        catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
        finally {
            client.release();
        }
    }
    static async updateOperatingClass(userId, activeClass) {
        const driver = await database_1.pool.query(`SELECT v.service_class 
       FROM driver_vehicles dv
       JOIN vehicles v ON dv.vehicle_id = v.id
       WHERE dv.driver_id = $1`, [userId]);
        if (driver.rows.length === 0)
            throw new Error('Driver vehicle not found');
        const vehicleClass = driver.rows[0].service_class;
        const eligibilityMap = {
            'PRESTIGE': ['CORE', 'ELITE', 'PRESTIGE'],
            'ELITE': ['CORE', 'ELITE'],
            'CORE': ['CORE']
        };
        if (!eligibilityMap[vehicleClass]?.includes(activeClass)) {
            throw new Error(`Your vehicle is not eligible for ${activeClass} mode.`);
        }
        const res = await database_1.pool.query('UPDATE drivers SET active_class = $1 WHERE user_id = $2 RETURNING *', [activeClass, userId]);
        return res.rows[0];
    }
    static async getRecommendations(userId) {
        const { DispatchService } = await Promise.resolve().then(() => __importStar(require('../../services/dispatch.service')));
        return DispatchService.getRecommendationsForDriver(userId);
    }
    static async updateProfile(userId, data) {
        const client = await database_1.pool.connect();
        try {
            await client.query('BEGIN');
            if (data.full_name || data.phone_number || data.profile_image_url) {
                const fields = [];
                const values = [];
                let i = 1;
                if (data.full_name) {
                    fields.push(`full_name = $${i++}`);
                    values.push(data.full_name);
                }
                if (data.phone_number) {
                    fields.push(`phone_number = $${i++}`);
                    values.push(data.phone_number);
                }
                if (data.profile_image_url) {
                    fields.push(`profile_image_url = $${i++}`);
                    values.push(data.profile_image_url);
                }
                values.push(userId);
                await client.query(`UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i}`, values);
            }
            if (data.license_number || data.license_expiry_date) {
                const fields = [];
                const values = [];
                let i = 1;
                if (data.license_number) {
                    fields.push(`license_number = $${i++}`);
                    values.push(data.license_number);
                }
                if (data.license_expiry_date) {
                    fields.push(`license_expiry_date = $${i++}`);
                    values.push(data.license_expiry_date);
                }
                values.push(userId);
                await client.query(`UPDATE drivers SET ${fields.join(', ')} WHERE user_id = $${i}`, values);
            }
            if (data.vehicle_id || data.license_plate_number) {
                if (data.license_plate_number) {
                    await client.query(`UPDATE driver_vehicles SET license_plate_number = $1 WHERE driver_id = $2`, [data.license_plate_number, userId]);
                }
                if (data.vehicle_id) {
                    await client.query(`UPDATE driver_vehicles SET vehicle_id = $1 WHERE driver_id = $2`, [data.vehicle_id, userId]);
                }
            }
            await client.query('COMMIT');
            return this.getProfile(userId);
        }
        catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
        finally {
            client.release();
        }
    }
    static async requestVerification(userId, data) {
        const client = await database_1.pool.connect();
        try {
            await client.query('BEGIN');
            if (data.date_of_birth) {
                await client.query('UPDATE users SET is_verified = false, date_of_birth = $1 WHERE id = $2', [data.date_of_birth, userId]);
            }
            else {
                await client.query('UPDATE users SET is_verified = false WHERE id = $1', [userId]);
            }
            const driverUpdateFields = ['is_active = false', "background_check_status = 'PENDING'"];
            const driverUpdateValues = [];
            let i = 1;
            if (!data.license_photo_url || !data.license_photo_back_url) {
                throw new Error('Both front and back photos of the license are mandatory for verification');
            }
            if (data.license_number) {
                driverUpdateFields.push(`license_number = $${i++}`);
                driverUpdateValues.push(data.license_number);
            }
            if (data.license_photo_url) {
                driverUpdateFields.push(`license_photo_url = $${i++}`);
                driverUpdateValues.push(data.license_photo_url);
            }
            if (data.license_photo_back_url) {
                driverUpdateFields.push(`license_photo_back_url = $${i++}`);
                driverUpdateValues.push(data.license_photo_back_url);
            }
            driverUpdateValues.push(userId);
            await client.query(`UPDATE drivers SET ${driverUpdateFields.join(', ')} WHERE user_id = $${i}`, driverUpdateValues);
            await client.query('COMMIT');
            const profile = await this.getProfile(userId);
            if (!profile.profile_image_url) {
                throw new Error('Profile picture is mandatory. Please upload one in your profile.');
            }
            email_service_1.EmailService.sendDriverRegistrationNotice({
                personalInfo: {
                    userId,
                    full_name: profile.full_name,
                    email: profile.email,
                    phone_number: profile.phone_number,
                    date_of_birth: profile.date_of_birth,
                    profile_image_url: profile.profile_image_url,
                },
                identity: {
                    license_number: profile.license_number,
                    license_photo_url: profile.license_photo_url,
                    license_photo_back_url: profile.license_photo_back_url,
                    license_expiry_date: profile.license_expiry_date,
                },
                vehicle: profile.vehicles && profile.vehicles[0] ? profile.vehicles[0] : {},
            });
            return profile;
        }
        catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
        finally {
            client.release();
        }
    }
    static async getVehicles() {
        const res = await database_1.pool.query('SELECT * FROM vehicles');
        return res.rows;
    }
    static async getPricing(userId) {
        const driver = await prisma_service_1.prisma.driver.findUnique({
            where: { user_id: userId }
        });
        if (!driver)
            throw new Error('Driver profile not found.');
        // If ranges are not calculated yet, run recalculation
        if (driver.price_range_min === null || driver.price_range_max === null) {
            const { fareService } = await Promise.resolve().then(() => __importStar(require('../../services/fare.service')));
            await fareService.recalculateDriverRanges();
            const updated = await prisma_service_1.prisma.driver.findUnique({
                where: { user_id: userId }
            });
            return {
                price_per_mile: updated?.price_per_mile ? Number(updated.price_per_mile) : 2.00,
                price_range_min: updated?.price_range_min ? Number(updated.price_range_min) : 1.00,
                price_range_max: updated?.price_range_max ? Number(updated.price_range_max) : 3.00,
                recommended_price: updated?.recommended_price ? Number(updated.recommended_price) : 2.00,
                price_last_changed: updated?.price_last_changed
            };
        }
        return {
            price_per_mile: driver.price_per_mile ? Number(driver.price_per_mile) : 2.00,
            price_range_min: driver.price_range_min ? Number(driver.price_range_min) : 1.00,
            price_range_max: driver.price_range_max ? Number(driver.price_range_max) : 3.00,
            recommended_price: driver.recommended_price ? Number(driver.recommended_price) : 2.00,
            price_last_changed: driver.price_last_changed
        };
    }
    static async updatePrice(userId, pricePerMile) {
        const driver = await prisma_service_1.prisma.driver.findUnique({
            where: { user_id: userId }
        });
        if (!driver)
            throw new Error('Driver profile not found.');
        // Enforce 4 hours change limit
        if (driver.price_last_changed) {
            const lastChanged = new Date(driver.price_last_changed).getTime();
            const fourHours = 4 * 60 * 60 * 1000;
            if (Date.now() - lastChanged < fourHours) {
                throw new Error('You can only change your driving price once every 4 hours.');
            }
        }
        // Validate bounds
        const min = Number(driver.price_range_min || 1.00);
        const max = Number(driver.price_range_max || 3.00);
        if (pricePerMile < min || pricePerMile > max) {
            throw new Error(`Chosen price must be within your system range of \$${min.toFixed(2)} to \$${max.toFixed(2)}.`);
        }
        // Validate step: must be multiple of $0.25 (e.g. price * 100 % 25 == 0)
        const cents = Math.round(pricePerMile * 100);
        if (cents % 25 !== 0) {
            throw new Error('Pricing adjustments must be in increments of 25 cents.');
        }
        const updated = await prisma_service_1.prisma.driver.update({
            where: { user_id: userId },
            data: {
                price_per_mile: pricePerMile,
                price_last_changed: new Date()
            }
        });
        return {
            price_per_mile: Number(updated.price_per_mile),
            price_range_min: Number(updated.price_range_min),
            price_range_max: Number(updated.price_range_max),
            recommended_price: Number(updated.recommended_price),
            price_last_changed: updated.price_last_changed
        };
    }
    // ============================================================
    // Profile-change approval queue (020)
    // ============================================================
    static async submitProfileChange(userId, changes) {
        // Reject if the driver already has an open PENDING request.
        const open = await database_1.pool.query(`SELECT id FROM profile_change_requests WHERE driver_id = $1 AND status = 'PENDING' LIMIT 1`, [userId]);
        if (open.rowCount && open.rowCount > 0) {
            throw new Error('PROFILE_CHANGE_PENDING: A previous change is still awaiting admin review.');
        }
        // 24-hour rate limit per driver (any status). Uses Redis with a fallback
        // to "fail closed" — if Redis is down we refuse rather than allow abuse.
        const rateKey = `profile-change:rate:${userId}`;
        try {
            const count = await redis_1.redis.incr(rateKey);
            if (count === 1)
                await redis_1.redis.expire(rateKey, 24 * 60 * 60);
            if (count > 1)
                throw new Error('RATE_LIMITED: You can only submit a profile change once every 24 hours.');
        }
        catch (err) {
            if (err.message.startsWith('RATE_LIMITED'))
                throw err;
            console.warn('[DRIVER] Redis unavailable, refusing rate-limit check:', err.message);
            throw new Error('RATE_LIMITED: Rate-limit service unavailable. Please try again shortly.');
        }
        // If the request contains a payout_card, validate and pre-create the
        // PENDING card row. We keep only last4 + brand + exp + name + zip;
        // PAN and CVC are discarded after validation.
        let payoutCardId = null;
        let cardLast4 = null;
        let cardBrand = null;
        let sanitizedChanges = { ...changes };
        if (changes.payout_card) {
            const pc = changes.payout_card;
            const digits = pc.card_number.replace(/\D/g, '');
            if (!(0, card_1.isValidLuhn)(digits))
                throw new Error('INVALID_CARD: Card number failed validation.');
            if (pc.brand && !['visa', 'mastercard', 'amex', 'discover', 'unknown'].includes(pc.brand)) {
                // Brand is auto-detected; reject client-supplied brand on principle.
            }
            const brand = (0, card_1.detectCardBrand)(digits);
            const l4 = digits.slice(-4);
            const cardInsert = await database_1.pool.query(`INSERT INTO payout_cards (driver_id, brand, last4, exp_month, exp_year, cardholder_name, zip, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING') RETURNING id`, [userId, brand, l4, pc.exp_month, pc.exp_year, pc.cardholder_name.trim(), pc.zip.trim()]);
            payoutCardId = cardInsert.rows[0].id;
            cardLast4 = l4;
            cardBrand = brand;
            // Strip the full PAN/CVC before persisting the diff.
            delete sanitizedChanges.payout_card;
            sanitizedChanges.payout_card_id = payoutCardId;
        }
        // If a phone change is requested, verify the OTP was completed within
        // the last 10 minutes (verified_codes.verified_at). If the verification
        // table isn't reachable we fail closed.
        if (sanitizedChanges.phone_number) {
            const otpCheck = await database_1.pool.query(`SELECT verified_at FROM verification_codes
         WHERE phone_number = $1 AND verified = true AND verified_at > NOW() - INTERVAL '10 minutes'
         ORDER BY verified_at DESC LIMIT 1`, [sanitizedChanges.phone_number]);
            if (!otpCheck.rowCount) {
                // Clean up the just-inserted card if any
                if (payoutCardId)
                    await database_1.pool.query(`DELETE FROM payout_cards WHERE id = $1`, [payoutCardId]);
                throw new Error('PHONE_NOT_VERIFIED: Please verify the new phone number with the OTP we sent before submitting.');
            }
        }
        // Snapshot the driver state so a future rejection can restore it.
        const driverRes = await database_1.pool.query(`SELECT is_active, background_check_status FROM drivers WHERE user_id = $1`, [userId]);
        const prevIsActive = driverRes.rows[0]?.is_active ?? false;
        const prevBgStatus = driverRes.rows[0]?.background_check_status ?? 'PENDING';
        const client = await database_1.pool.connect();
        let requestId;
        try {
            await client.query('BEGIN');
            const inserted = await client.query(`INSERT INTO profile_change_requests
          (driver_id, requested_changes, status, card_last4, card_brand, prev_is_active, prev_bg_status)
         VALUES ($1, $2, 'PENDING', $3, $4, $5, $6) RETURNING id, created_at`, [userId, sanitizedChanges, cardLast4, cardBrand, prevIsActive, prevBgStatus]);
            requestId = inserted.rows[0].id;
            // Block the driver from driving while the change is pending.
            await client.query(`UPDATE drivers SET is_active = false, background_check_status = 'PENDING' WHERE user_id = $1`, [userId]);
            await client.query('COMMIT');
        }
        catch (err) {
            await client.query('ROLLBACK');
            // Race: another PENDING row won the EXCLUDE constraint
            if (err.message?.includes('one_open_change_per_driver')) {
                throw new Error('PROFILE_CHANGE_PENDING: A previous change is still awaiting admin review.');
            }
            throw err;
        }
        finally {
            client.release();
        }
        // Fire-and-forget emails.
        const driverInfo = await database_1.pool.query(`SELECT email, full_name FROM users WHERE id = $1`, [userId]);
        const driverEmail = driverInfo.rows[0]?.email ?? '';
        const driverName = driverInfo.rows[0]?.full_name ?? 'Driver';
        try {
            await email_service_1.EmailService.sendProfileChangeSubmittedEmail({ email: driverEmail, full_name: driverName }, { id: requestId, requested_changes: sanitizedChanges, card_last4: cardLast4, card_brand: cardBrand });
            await email_service_1.EmailService.sendProfileChangeNotice({ email: env_1.env.GMAIL_USER_EMAIL || '' }, { id: userId, email: driverEmail, full_name: driverName }, { id: requestId, requested_changes: sanitizedChanges, card_last4: cardLast4, card_brand: cardBrand });
        }
        catch (e) {
            console.warn('[DRIVER] ⚠️ Profile change emails failed:', e.message);
        }
        return {
            request_id: requestId,
            status: 'PENDING',
            has_pending: true,
            queued_changes: Object.keys(sanitizedChanges),
            card_last4: cardLast4,
            card_brand: cardBrand,
        };
    }
    static async getCurrentProfileChange(userId) {
        const res = await database_1.pool.query(`SELECT id, requested_changes, status, created_at, reviewed_at, rejection_reason, card_last4, card_brand
       FROM profile_change_requests
       WHERE driver_id = $1
       ORDER BY created_at DESC LIMIT 1`, [userId]);
        if (!res.rowCount)
            return { status: 'NONE' };
        const r = res.rows[0];
        return {
            request_id: r.id,
            status: r.status,
            created_at: r.created_at,
            reviewed_at: r.reviewed_at,
            rejection_reason: r.rejection_reason,
            changes: r.requested_changes,
            card_last4: r.card_last4,
            card_brand: r.card_brand,
        };
    }
    // ============================================================
    // Wallet + payout cards + payouts (020)
    // ============================================================
    static async addPayoutCard(userId, payload) {
        const digits = String(payload.card_number).replace(/\D/g, '');
        if (!(0, card_1.isValidLuhn)(digits))
            throw new Error('INVALID_CARD: Card number failed validation.');
        const brand = (0, card_1.detectCardBrand)(digits);
        const l4 = digits.slice(-4);
        const ins = await database_1.pool.query(`INSERT INTO payout_cards (driver_id, brand, last4, exp_month, exp_year, cardholder_name, zip, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING') RETURNING id, created_at`, [userId, brand, l4, payload.exp_month, payload.exp_year, payload.cardholder_name.trim(), payload.zip.trim()]);
        // Make sure the wallet row exists so an admin approval can attach a card.
        await database_1.pool.query(`INSERT INTO driver_wallets (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`, [userId]);
        // Notify admin
        try {
            const driverInfo = await database_1.pool.query(`SELECT email, full_name FROM users WHERE id = $1`, [userId]);
            await email_service_1.EmailService.sendPayoutCardNotice({ email: env_1.env.GMAIL_USER_EMAIL || '' }, { id: userId, email: driverInfo.rows[0]?.email ?? '', full_name: driverInfo.rows[0]?.full_name ?? 'Driver' }, { id: ins.rows[0].id, brand, last4: l4 });
        }
        catch (e) {
            console.warn('[DRIVER] ⚠️ Payout-card admin notice failed:', e.message);
        }
        return {
            card_id: ins.rows[0].id,
            status: 'PENDING',
            brand,
            last4: l4,
            exp_month: payload.exp_month,
            exp_year: payload.exp_year,
        };
    }
    static async getWallet(userId) {
        // Ensure the wallet row exists.
        await database_1.pool.query(`INSERT INTO driver_wallets (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`, [userId]);
        const wRes = await database_1.pool.query(`SELECT * FROM driver_wallets WHERE driver_id = $1`, [userId]);
        const wallet = wRes.rows[0];
        let cardSummary = null;
        if (wallet?.payout_card_id) {
            const cRes = await database_1.pool.query(`SELECT id, brand, last4, exp_month, exp_year, cardholder_name, status FROM payout_cards WHERE id = $1`, [wallet.payout_card_id]);
            cardSummary = cRes.rows[0] ?? null;
        }
        const pRes = await database_1.pool.query(`SELECT id, amount_cents, fee_cents, net_cents, status, method, requested_at, processed_at, reference, notes
       FROM payouts WHERE driver_id = $1 ORDER BY requested_at DESC LIMIT 5`, [userId]);
        return {
            balance_cents: Number(wallet?.balance_cents ?? 0),
            lifetime_earnings_cents: Number(wallet?.lifetime_earnings_cents ?? 0),
            payout_card: cardSummary,
            recent_payouts: pRes.rows,
        };
    }
    static async requestOnDemandPayout(userId, amountCents) {
        const MIN_PAYOUT_CENTS = 1000; // $10 minimum
        if (amountCents < MIN_PAYOUT_CENTS) {
            throw new Error(`MIN_PAYOUT: Minimum on-demand payout is $${MIN_PAYOUT_CENTS / 100}.`);
        }
        await database_1.pool.query(`INSERT INTO driver_wallets (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`, [userId]);
        const wRes = await database_1.pool.query(`SELECT * FROM driver_wallets WHERE driver_id = $1`, [userId]);
        const wallet = wRes.rows[0];
        if (!wallet?.payout_card_id)
            throw new Error('NO_PAYOUT_CARD: Add a payout card before requesting a payout.');
        if (Number(wallet.balance_cents) < amountCents) {
            throw new Error('INSUFFICIENT_BALANCE: Requested amount exceeds your wallet balance.');
        }
        const fee = Math.round(amountCents * 0.05);
        const net = amountCents - fee;
        const client = await database_1.pool.connect();
        let payoutId;
        try {
            await client.query('BEGIN');
            // Debit wallet
            const upd = await client.query(`UPDATE driver_wallets SET balance_cents = balance_cents - $1, updated_at = NOW()
         WHERE driver_id = $2 AND balance_cents >= $1 RETURNING balance_cents`, [amountCents, userId]);
            if (!upd.rowCount)
                throw new Error('INSUFFICIENT_BALANCE: Insufficient wallet balance.');
            const ins = await client.query(`INSERT INTO payouts (driver_id, amount_cents, fee_cents, net_cents, status, method)
         VALUES ($1, $2, $3, $4, 'PENDING', 'ON_DEMAND') RETURNING id, requested_at`, [userId, amountCents, fee, net]);
            payoutId = ins.rows[0].id;
            await client.query('COMMIT');
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
        // Admin notification
        try {
            const driverInfo = await database_1.pool.query(`SELECT email, full_name FROM users WHERE id = $1`, [userId]);
            await email_service_1.EmailService.sendPayoutRequestedNotice({ email: env_1.env.GMAIL_USER_EMAIL || '' }, { id: userId, email: driverInfo.rows[0]?.email ?? '', full_name: driverInfo.rows[0]?.full_name ?? 'Driver' }, { id: payoutId, amount_cents: amountCents, fee_cents: fee, net_cents: net, method: 'ON_DEMAND' });
        }
        catch (e) {
            console.warn('[DRIVER] ⚠️ Payout-request admin notice failed:', e.message);
        }
        return {
            payout_id: payoutId,
            amount_cents: amountCents,
            fee_cents: fee,
            net_cents: net,
            status: 'PENDING',
            method: 'ON_DEMAND',
        };
    }
    static async listMyPayouts(userId, limit, offset) {
        const res = await database_1.pool.query(`SELECT id, amount_cents, fee_cents, net_cents, status, method, requested_at, processed_at, reference, notes
       FROM payouts WHERE driver_id = $1 ORDER BY requested_at DESC LIMIT $2 OFFSET $3`, [userId, limit, offset]);
        const total = await database_1.pool.query(`SELECT COUNT(*)::int AS c FROM payouts WHERE driver_id = $1`, [userId]);
        return { payouts: res.rows, total: total.rows[0]?.c ?? 0 };
    }
    /**
     * Idempotent ride-completion wallet credit. Safe to call multiple times
     * for the same ride — the unique index on payouts(ride_id) WHERE
     * method='RIDE_CREDIT' prevents double-counting.
     */
    static async creditOnRideComplete(driverId, fareCents, rideId) {
        if (!driverId || fareCents <= 0)
            return;
        const client = await database_1.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`INSERT INTO driver_wallets (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`, [driverId]);
            await client.query(`UPDATE driver_wallets
         SET balance_cents = balance_cents + $1,
             lifetime_earnings_cents = lifetime_earnings_cents + $1,
             updated_at = NOW()
         WHERE driver_id = $2`, [fareCents, driverId]);
            await client.query(`INSERT INTO payouts (driver_id, amount_cents, fee_cents, net_cents, status, method, ride_id)
         VALUES ($1, $2, 0, $2, 'PAID', 'RIDE_CREDIT', $3)
         ON CONFLICT (ride_id) WHERE method = 'RIDE_CREDIT' DO NOTHING`, [driverId, fareCents, rideId]);
            await client.query('COMMIT');
        }
        catch (err) {
            await client.query('ROLLBACK');
            console.error(`[WALLET] ❌ creditOnRideComplete failed for driver ${driverId}:`, err.message);
            throw err;
        }
        finally {
            client.release();
        }
    }
}
exports.DriverService = DriverService;
//# sourceMappingURL=driver.service.js.map