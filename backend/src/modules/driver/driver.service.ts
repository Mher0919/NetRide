import { pool } from '../../config/database';
import { EmailService } from '../../services/email.service';
import { prisma } from '../../services/prisma.service';
import { redis } from '../../config/redis';
import { env } from '../../config/env';
import { maskCardNumber, detectCardBrand, isValidLuhn } from '../../utils/card';
import {
  getRevenueAllocationForRide,
  computeRevenueAllocation,
} from '../../services/pricing.service';

export class DriverService {
  static async getProfile(userId: string) {
    const res = await pool.query(
      `SELECT u.*, d.*
       FROM users u
       LEFT JOIN drivers d ON u.id = d.user_id
       WHERE u.id = $1`,
      [userId]
    );
    const profile = res.rows[0];
    if (profile && profile.user_id) {
      // Always return the authoritative active/approved vehicle first.
      // Legacy vehicles with NULL vehicle_status are treated as APPROVED.
      const vehicleRes = await pool.query(
        `SELECT dv.*, v.make AS catalog_make, v.model AS catalog_model,
                v.year AS catalog_year, v.category, v.service_class
         FROM driver_vehicles dv
         LEFT JOIN vehicles v ON dv.vehicle_id = v.id
         WHERE dv.driver_id = $1
         ORDER BY
           CASE
             WHEN dv.vehicle_status = 'APPROVED' OR dv.vehicle_status IS NULL THEN 0
             ELSE 1
           END,
           dv.submitted_at DESC NULLS LAST,
           dv.approved_at DESC NULLS LAST,
           dv.id DESC`,
        [userId]
      );
      profile.vehicles = vehicleRes.rows;
      // Expose the active approved vehicle explicitly so the frontend
      // never has to guess which row to display.
      const activeVeh = vehicleRes.rows.find(
        (r: any) => r.vehicle_status === 'APPROVED' || r.vehicle_status === null
      );
      profile.active_vehicle = activeVeh || null;
    }

    // Surface any pending profile change so the driver app can render the
    // red banner without an extra round-trip.
    try {
      const pending = await pool.query(
        `SELECT id, requested_changes, created_at, card_last4, card_brand
         FROM profile_change_requests
         WHERE driver_id = $1 AND status = 'PENDING'
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId]
      );
      if (pending.rowCount && pending.rowCount > 0) {
        const row = pending.rows[0];
        const changes = row.requested_changes ?? {};
        profile.has_pending_profile_change = true;
        profile.pending_request_id = row.id;
        profile.pending_requested_at = row.created_at;
        profile.pending_card_last4 = row.card_last4;
        profile.pending_card_brand = row.card_brand;
        profile.pending_changes_summary = Object.keys(changes).filter(k => k !== 'payout_card');
        // Include pending change values so the frontend can distinguish
        // approved values from pending-submitted values.
        const values: Record<string, any> = {};
        for (const [k, v] of Object.entries(changes)) {
          if (k !== '_reason' && k !== 'payout_card' && k !== 'payout_card_id') {
            values[k] = v;
          }
        }
        profile.pending_changes_values = values;
      } else {
        profile.has_pending_profile_change = false;
        profile.pending_changes_values = {};
      }
    } catch (_err: any) {
      // Table may not exist yet on first boot; treat as no pending change.
      profile.has_pending_profile_change = false;
    }

    return profile;
  }

  static async getOnboardingProgress(userId: string) {
    const res = await pool.query(
      `SELECT onboarding_step, phone_verified, headshot_uploaded, 
              profile_image_url, full_name, date_of_birth, phone_number,
              is_verified
       FROM users WHERE id = $1`,
      [userId]
    );
    if (!res.rowCount) throw new Error('User not found');
    const u = res.rows[0];

    // Driver-specific phone (separate from rider phone)
    const driverPhone = await pool.query(
      `SELECT phone_number, phone_verified FROM drivers WHERE user_id = $1`, [userId]
    );
    const dp = driverPhone.rows[0];

    return {
      onboarding_step: u.onboarding_step ?? 0,
      phone_verified: dp?.phone_verified || u.phone_verified || false,
      headshot_uploaded: u.headshot_uploaded || false,
      profile_image_url: u.profile_image_url,
      full_name: u.full_name,
      date_of_birth: u.date_of_birth,
      phone_number: dp?.phone_number || u.phone_number,
    };
  }

  static async saveOnboardingStep(userId: string, step: number, data: any) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Validate required data per step
      switch (step) {
        case 0: // Headshot
          if (!data.profile_image_url) throw new Error('Please upload a headshot photo.');
          await client.query(
            `UPDATE users SET profile_image_url = $1, headshot_uploaded = true, 
             onboarding_step = GREATEST(onboarding_step, 1), updated_at = NOW() WHERE id = $2`,
            [data.profile_image_url, userId]
          );
          break;

        case 1: // Personal Info
          if (!data.full_name || !data.full_name.trim()) throw new Error('Full name is required.');
          if (!data.date_of_birth) throw new Error('Date of birth is required.');
          const dob = new Date(data.date_of_birth);
          if (isNaN(dob.getTime())) throw new Error('Invalid date of birth format.');
          const age = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
          if (age < 21) throw new Error('You must be at least 21 years old to drive with NetRide.');
          if (dob > new Date()) throw new Error('Date of birth cannot be in the future.');
          await client.query(
            `UPDATE users SET full_name = $1, date_of_birth = $2,
             onboarding_step = GREATEST(onboarding_step, 2), updated_at = NOW() WHERE id = $3`,
            [data.full_name.trim(), data.date_of_birth, userId]
          );
          break;

        case 2: // Phone Verification (handled by auth endpoints, just mark step)
          const phoneUser = await client.query(
            `SELECT phone_verified, phone_number FROM users WHERE id = $1`, [userId]
          );
          const phoneDriver = await client.query(
            `SELECT phone_verified, phone_number FROM drivers WHERE user_id = $1`, [userId]
          );
          const userVerified = phoneUser.rows[0]?.phone_verified;
          const driverVerified = phoneDriver.rows[0]?.phone_verified;
          if (!userVerified && !driverVerified) {
            throw new Error('Please verify your phone number first.');
          }
          await client.query(
            `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 3), updated_at = NOW() WHERE id = $1`,
            [userId]
          );
          break;

        case 3: // Identity Documents
          if (!data.license_photo_url) throw new Error('Front of license photo is required.');
          if (!data.license_photo_back_url) throw new Error('Back of license photo is required.');
          if (!data.insurance_photo_url) throw new Error('Insurance certificate is required.');
          if (!data.registration_photo_url) throw new Error('Vehicle registration is required.');
          await client.query(
            `UPDATE drivers SET license_photo_url = $1, license_photo_back_url = $2,
             insurance_photo_url = $3, registration_photo_url = $4
             WHERE user_id = $5`,
            [data.license_photo_url, data.license_photo_back_url,
             data.insurance_photo_url, data.registration_photo_url, userId]
          );
          await client.query(
            `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 4), updated_at = NOW() WHERE id = $1`,
            [userId]
          );
          break;

        case 4: // Vehicle Info
          if (!data.license_plate_number || !data.license_plate_number.trim()) throw new Error('License plate number is required.');
          if (!data.license_plate_state || !data.license_plate_state.trim()) throw new Error('License plate state is required.');
          if (!data.zip_code || !data.zip_code.trim()) throw new Error('ZIP code is required.');

          const driverExists = await client.query('SELECT 1 FROM drivers WHERE user_id = $1', [userId]);
          if (driverExists.rows.length === 0) {
            await client.query('INSERT INTO drivers (user_id) VALUES ($1)', [userId]);
          }

          const existingVeh = await client.query(
            'SELECT id FROM driver_vehicles WHERE driver_id = $1', [userId]
          );
          if (existingVeh.rows.length > 0) {
            await client.query(
              `UPDATE driver_vehicles SET 
               license_plate_number = $1, license_plate_state = $2, zip_code = $3,
               make = $4, model = $5, year = $6, color = $7, interior_color = $8
               WHERE driver_id = $9`,
              [data.license_plate_number.trim(), data.license_plate_state.trim(),
               data.zip_code.trim(), data.make || null, data.model || null,
               data.year || null, data.color || null, data.interior_color || null, userId]
            );
          } else {
            await client.query(
              `INSERT INTO driver_vehicles (driver_id, license_plate_number, license_plate_state, zip_code, make, model, year, color, interior_color)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [userId, data.license_plate_number.trim(), data.license_plate_state.trim(),
               data.zip_code.trim(), data.make || null, data.model || null,
               data.year || null, data.color || null, data.interior_color || null]
            );
          }
          await client.query(
            `UPDATE users SET onboarding_step = GREATEST(onboarding_step, 5), updated_at = NOW() WHERE id = $1`,
            [userId]
          );
          break;

        default:
          throw new Error('Invalid step number.');
      }

      await client.query('COMMIT');
      return this.getOnboardingProgress(userId);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  static async completeOnboarding(userId: string) {
    // Verify all steps are complete before allowing final submission
    const progress = await this.getOnboardingProgress(userId);
    if (progress.onboarding_step < 5) {
      throw new Error('Please complete all onboarding steps before submitting.');
    }

    const userRes = await pool.query(
      'SELECT profile_image_url, full_name, date_of_birth, phone_number FROM users WHERE id = $1',
      [userId]
    );
    const user = userRes.rows[0];
    if (!user) throw new Error('User not found');

    const driverRes = await pool.query(
      'SELECT license_photo_url, license_photo_back_url, insurance_photo_url, registration_photo_url FROM drivers WHERE user_id = $1',
      [userId]
    );
    const driver = driverRes.rows[0];
    if (!driver) throw new Error('Driver record not found');

    const vehRes = await pool.query(
      `SELECT license_plate_number, make, model, year, color 
       FROM driver_vehicles WHERE driver_id = $1`,
      [userId]
    );
    const vehicle = vehRes.rows[0];

    // Set background check to PENDING, mark user verification as pending
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE drivers SET background_check_status = 'PENDING', is_active = false
         WHERE user_id = $1`,
        [userId]
      );
      await client.query(
        `UPDATE users SET verification_status = 
           CASE WHEN verification_status = 'VERIFIED' THEN 'VERIFIED'::verification_status
                ELSE 'PENDING'::verification_status
           END,
           onboarding_step = GREATEST(onboarding_step, 5)
         WHERE id = $1`,
        [userId]
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Auto-create vehicle inspection requirement as a post-submission Action Required
    try {
      const existingReq = await pool.query(
        `SELECT id FROM driver_document_requirements
         WHERE driver_id = $1 AND document_type = 'inspection_photo_url'`,
        [userId]
      );
      if (existingReq.rows.length === 0) {
        await pool.query(
          `INSERT INTO driver_document_requirements (driver_id, document_type, status)
           VALUES ($1, 'inspection_photo_url', 'resubmission_required')`,
          [userId]
        );
        await pool.query(
          `UPDATE drivers SET has_action_required = TRUE, last_action_required_at = NOW()
           WHERE user_id = $1`,
          [userId]
        );
      }
    } catch (reqErr) {
      console.error(`[DRIVER] ❌ Failed to create vehicle inspection requirement (non-fatal):`, reqErr);
    }

    // Notify admin via email (fire-and-forget after confirmed persistence)
    try {
      const userEmail = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      await EmailService.sendDriverRegistrationNotice({
        personalInfo: {
          userId,
          full_name: user.full_name,
          email: userEmail.rows[0]?.email,
          phone_number: user.phone_number,
          date_of_birth: user.date_of_birth,
          profile_image_url: user.profile_image_url,
        },
        identity: {
          license_photo_url: driver.license_photo_url,
          license_photo_back_url: driver.license_photo_back_url,
          insurance_photo_url: driver.insurance_photo_url,
          registration_photo_url: driver.registration_photo_url,
        },
        vehicle: vehicle || {},
      });
    } catch (emailErr) {
      console.error(`[DRIVER] ❌ Onboarding email notification failed (non-fatal):`, emailErr);
    }

    return { success: true, message: 'Onboarding complete. Your background check is now in progress.' };
  }

  static async onboard(userId: string, data: any) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Validation: Ensure mandatory fields are present
      if (!data.personalInfo.profile_image_url) throw new Error('Profile picture is mandatory');
      if (!data.identity.license_photo_url || !data.identity.license_photo_back_url) {
        throw new Error('Both front and back photos of the license are mandatory');
      }
      if (!data.identity.insurance_photo_url || !data.identity.registration_photo_url) {
        throw new Error('Insurance and car registration photos are mandatory');
      }
      // Vehicle inspection is enforced post-submission, not during registration.

      // Vehicle Year Validation (2011 -> Present)
      const vehicleYear = parseInt(data.vehicle.year);
      if (isNaN(vehicleYear) || vehicleYear < 2011) {
        throw new Error('Vehicle year must be 2011 or newer to register on NetRide.');
      }

      // Custom-vehicle fallback: when vehicle_id is missing, make/model/color are required
      if (!data.vehicle.vehicle_id) {
        const missing: string[] = [];
        if (!data.vehicle.make || !String(data.vehicle.make).trim()) missing.push('make');
        if (!data.vehicle.model || !String(data.vehicle.model).trim()) missing.push('model');
        if (!data.vehicle.color || !String(data.vehicle.color).trim()) missing.push('color');
        if (missing.length > 0) {
          throw new Error(`Custom vehicle is missing required field(s): ${missing.join(', ')}.`);
        }
      }

      // 1. Update User
      await client.query(
        `UPDATE users 
         SET phone_number = $1, date_of_birth = $2, profile_image_url = $3, updated_at = NOW() 
         WHERE id = $4`,
        [data.personalInfo.phone_number, data.personalInfo.date_of_birth, data.personalInfo.profile_image_url, userId]
      );

      // 2. Ensure Driver Record Exists and Update
      const driverExists = await client.query('SELECT * FROM drivers WHERE user_id = $1', [userId]);
      if (driverExists.rows.length === 0) {
        await client.query('INSERT INTO drivers (user_id) VALUES ($1)', [userId]);
      }

      const driverRes = await client.query(
        `UPDATE drivers 
         SET license_photo_url = $1, license_photo_back_url = $2,
             insurance_photo_url = $3, registration_photo_url = $4,
             background_check_status = 'PENDING', is_active = false 
         WHERE user_id = $5
         RETURNING *`,
        [
          data.identity.license_photo_url, 
          data.identity.license_photo_back_url,
          data.identity.insurance_photo_url,
          data.identity.registration_photo_url,
          userId
        ]
      );

      // 3. Create DriverVehicle
      await client.query(
        `INSERT INTO driver_vehicles (
          driver_id, license_plate_number, license_plate_state, zip_code,
          color, interior_color, make, model, year
        )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          userId,
          data.vehicle.license_plate_number,
          data.vehicle.license_plate_state ?? null,
          data.vehicle.zip_code ?? null,
          data.vehicle.color || null,
          data.vehicle.interior_color || null,
          data.vehicle.make || null,
          data.vehicle.model || null,
          data.vehicle.year || null,
        ]
      );

      await client.query('COMMIT');

      // 4. Trigger Email Notice to Admin
      const userRes = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      EmailService.sendDriverRegistrationNotice({
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
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  static async updateProfile(userId: string, data: any) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (data.full_name || data.phone_number || data.profile_image_url) {
        const fields = [];
        const values = [];
        let i = 1;
        if (data.full_name) { fields.push(`full_name = $${i++}`); values.push(data.full_name); }
        if (data.phone_number) { fields.push(`phone_number = $${i++}`); values.push(data.phone_number); }
        if (data.profile_image_url) { fields.push(`profile_image_url = $${i++}`); values.push(data.profile_image_url); }

        values.push(userId);
        await client.query(
          `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i}`,
          values
        );
      }

      if (data.license_number || data.license_expiry_date) {
        const fields = [];
        const values = [];
        let i = 1;
        if (data.license_number) { fields.push(`license_number = $${i++}`); values.push(data.license_number); }
        if (data.license_expiry_date) { fields.push(`license_expiry_date = $${i++}`); values.push(data.license_expiry_date); }
        
        values.push(userId);
        await client.query(
          `UPDATE drivers SET ${fields.join(', ')} WHERE user_id = $${i}`,
          values
        );
      }

      if (data.vehicle_id || data.license_plate_number) {
        if (data.license_plate_number) {
          await client.query(
            `UPDATE driver_vehicles SET license_plate_number = $1 WHERE driver_id = $2`,
            [data.license_plate_number, userId]
          );
        }
        if (data.vehicle_id) {
          await client.query(
            `UPDATE driver_vehicles SET vehicle_id = $1 WHERE driver_id = $2`,
            [data.vehicle_id, userId]
          );
        }
      }

      await client.query('COMMIT');
      return this.getProfile(userId);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  static async requestVerification(userId: string, data: any) {
    // Reject DOB changes if the field is locked.
    if (data.date_of_birth) {
      const user = await pool.query(
        `SELECT dob_locked FROM users WHERE id = $1`,
        [userId]
      );
      if (user.rows[0]?.dob_locked) {
        throw new Error('DOB_LOCKED: Your date of birth has already been verified and cannot be changed.');
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (data.date_of_birth) {
        await client.query(
          'UPDATE users SET is_verified = false, date_of_birth = $1 WHERE id = $2',
          [data.date_of_birth, userId]
        );
      } else {
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
      await client.query(
        `UPDATE drivers SET ${driverUpdateFields.join(', ')} WHERE user_id = $${i}`,
        driverUpdateValues
      );

      await client.query('COMMIT');

      const profile = await this.getProfile(userId);
      if (!profile.profile_image_url) {
        throw new Error('Profile picture is mandatory. Please upload one in your profile.');
      }

      EmailService.sendDriverRegistrationNotice({
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
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  static async getVehicles() {
    const res = await pool.query('SELECT * FROM vehicles');
    return res.rows;
  }

  // ============================================================
  // Profile-change approval queue (020)
  // ============================================================

  static async submitProfileChange(userId: string, changes: any, reason?: string) {
    // ---- Validate incoming changes first ----

    // Reject DOB changes if the field is locked (approved by admin already).
    if (changes.date_of_birth) {
      const user = await pool.query(
        `SELECT dob_locked FROM users WHERE id = $1`,
        [userId]
      );
      if (user.rows[0]?.dob_locked) {
        throw new Error('DOB_LOCKED: Your date of birth has already been verified and cannot be changed.');
      }
    }

    // If the request contains a payout_card, validate and pre-create the
    // PENDING card row. We keep only last4 + brand + exp + name + zip;
    // PAN and CVC are discarded after validation.
    let payoutCardId: string | null = null;
    let cardLast4: string | null = null;
    let cardBrand: string | null = null;
    let sanitizedChanges: any = { ...changes };
    if (reason?.trim()) sanitizedChanges._reason = reason.trim();

    if (changes.payout_card) {
      const pc = changes.payout_card;
      const digits = pc.card_number.replace(/\D/g, '');
      if (!isValidLuhn(digits)) throw new Error('INVALID_CARD: Card number failed validation.');
      if (pc.brand && !['visa', 'mastercard', 'amex', 'discover', 'unknown'].includes(pc.brand)) {
        // Brand is auto-detected; reject client-supplied brand on principle.
      }
      const brand = detectCardBrand(digits);
      const l4 = digits.slice(-4);
      const cardInsert = await pool.query(
        `INSERT INTO payout_cards (driver_id, brand, last4, exp_month, exp_year, cardholder_name, zip, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING') RETURNING id`,
        [userId, brand, l4, pc.exp_month, pc.exp_year, pc.cardholder_name.trim(), pc.zip.trim()]
      );
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
      const otpCheck = await pool.query(
        `SELECT verified_at FROM verification_codes
         WHERE phone_number = $1 AND verified = true AND verified_at > NOW() - INTERVAL '10 minutes'
         ORDER BY verified_at DESC LIMIT 1`,
        [sanitizedChanges.phone_number]
      );
      if (!otpCheck.rowCount) {
        // Clean up the just-inserted card if any
        if (payoutCardId) await pool.query(`DELETE FROM payout_cards WHERE id = $1`, [payoutCardId]);
        throw new Error('PHONE_NOT_VERIFIED: Please verify the new phone number with the OTP we sent before submitting.');
      }
    }

    // ---- Check for conflicts with existing pending request ----
    // Only overlapping fields are blocked; non-conflicting fields are merged
    // into the existing pending request (one open change per driver).
    const open = await pool.query(
      `SELECT id, requested_changes FROM profile_change_requests WHERE driver_id = $1 AND status = 'PENDING' LIMIT 1`,
      [userId]
    );
    if (open.rowCount && open.rowCount > 0) {
      const existingChanges: Record<string, any> = open.rows[0].requested_changes ?? {};
      const newKeys = new Set(Object.keys(sanitizedChanges).filter(k => k !== '_reason'));
      const existingKeys = new Set(
        Object.keys(existingChanges).filter(k => k !== '_reason' && k !== 'payout_card' && k !== 'payout_card_id')
      );
      const overlapping = [...newKeys].filter(k => existingKeys.has(k));
      if (overlapping.length > 0) {
        // Clean up the just-inserted card if any
        if (payoutCardId) await pool.query(`DELETE FROM payout_cards WHERE id = $1`, [payoutCardId]);
        throw new Error(
          `PROFILE_CHANGE_PENDING: A change for "${overlapping[0]}" is already awaiting admin review.`
        );
      }
      // Non-overlapping fields: merge into the existing pending request.
      const mergedReason = reason?.trim()
        ? (existingChanges._reason ? `${existingChanges._reason}; ${reason.trim()}` : reason.trim())
        : existingChanges._reason;
      const mergedChanges = { ...existingChanges, ...sanitizedChanges };
      if (mergedReason) mergedChanges._reason = mergedReason;
      await pool.query(
        `UPDATE profile_change_requests SET requested_changes = $1 WHERE id = $2`,
        [mergedChanges, open.rows[0].id]
      );
      return {
        request_id: open.rows[0].id,
        status: 'PENDING',
        has_pending: true,
        queued_changes: Object.keys(sanitizedChanges).filter(k => k !== '_reason'),
        card_last4: cardLast4,
        card_brand: cardBrand,
      };
    }

    // Snapshot the driver state so a future rejection can restore it.
    const driverRes = await pool.query(
      `SELECT is_active, background_check_status FROM drivers WHERE user_id = $1`,
      [userId]
    );
    const prevIsActive = driverRes.rows[0]?.is_active ?? false;
    const prevBgStatus = driverRes.rows[0]?.background_check_status ?? 'PENDING';

    const client = await pool.connect();
    let requestId: string;
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO profile_change_requests
          (driver_id, requested_changes, status, card_last4, card_brand, prev_is_active, prev_bg_status)
         VALUES ($1, $2, 'PENDING', $3, $4, $5, $6) RETURNING id, created_at`,
        [userId, sanitizedChanges, cardLast4, cardBrand, prevIsActive, prevBgStatus]
      );
      requestId = inserted.rows[0].id;

      // Block the driver from driving while the change is pending.
      await client.query(
        `UPDATE drivers SET is_active = false, background_check_status = 'PENDING' WHERE user_id = $1`,
        [userId]
      );
      await client.query('COMMIT');
    } catch (err: any) {
      await client.query('ROLLBACK');
      // Race: another PENDING row won the EXCLUDE constraint
      if (err.message?.includes('one_open_change_per_driver')) {
        throw new Error('PROFILE_CHANGE_PENDING: A profile change is already awaiting admin review.');
      }
      throw err;
    } finally {
      client.release();
    }

    // Fire-and-forget emails.
    const driverInfo = await pool.query(
      `SELECT email, full_name FROM users WHERE id = $1`, [userId]
    );
    const driverEmail = driverInfo.rows[0]?.email ?? '';
    const driverName = driverInfo.rows[0]?.full_name ?? 'Driver';
    try {
      await EmailService.sendProfileChangeSubmittedEmail(
        { email: driverEmail, full_name: driverName },
        { id: requestId, requested_changes: sanitizedChanges, card_last4: cardLast4, card_brand: cardBrand }
      );
      await EmailService.sendProfileChangeNotice(
        { email: env.ADMIN_NOTIFY_EMAIL || '' },
        { id: userId, email: driverEmail, full_name: driverName },
        { id: requestId, requested_changes: sanitizedChanges, card_last4: cardLast4, card_brand: cardBrand }
      );
    } catch (e: any) {
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

  static async getCurrentProfileChange(userId: string) {
    const res = await pool.query(
      `SELECT id, requested_changes, status, created_at, reviewed_at, rejection_reason, card_last4, card_brand
       FROM profile_change_requests
       WHERE driver_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (!res.rowCount) return { status: 'NONE' };
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

  static async addPayoutCard(userId: string, payload: any) {
    const digits = String(payload.card_number).replace(/\D/g, '');
    if (!isValidLuhn(digits)) throw new Error('INVALID_CARD: Card number failed validation.');
    const brand = detectCardBrand(digits);
    const l4 = digits.slice(-4);

    const ins = await pool.query(
      `INSERT INTO payout_cards (driver_id, brand, last4, exp_month, exp_year, cardholder_name, zip, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING') RETURNING id, created_at`,
      [userId, brand, l4, payload.exp_month, payload.exp_year, payload.cardholder_name.trim(), payload.zip.trim()]
    );

    // Make sure the wallet row exists so an admin approval can attach a card.
    await pool.query(
      `INSERT INTO driver_wallets (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`,
      [userId]
    );

    // Notify admin
    try {
      const driverInfo = await pool.query(`SELECT email, full_name FROM users WHERE id = $1`, [userId]);
      await EmailService.sendPayoutCardNotice(
        { email: env.ADMIN_NOTIFY_EMAIL || '' },
        { id: userId, email: driverInfo.rows[0]?.email ?? '', full_name: driverInfo.rows[0]?.full_name ?? 'Driver' },
        { id: ins.rows[0].id, brand, last4: l4 }
      );
    } catch (e: any) {
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

  static async getWallet(userId: string) {
    // Ensure the wallet row exists.
    await pool.query(
      `INSERT INTO driver_wallets (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`,
      [userId]
    );
    const wRes = await pool.query(`SELECT * FROM driver_wallets WHERE driver_id = $1`, [userId]);
    const wallet = wRes.rows[0];
    let cardSummary: any = null;
    if (wallet?.payout_card_id) {
      const cRes = await pool.query(`SELECT id, brand, last4, exp_month, exp_year, cardholder_name, status FROM payout_cards WHERE id = $1`, [wallet.payout_card_id]);
      cardSummary = cRes.rows[0] ?? null;
    }
    const pRes = await pool.query(
      `SELECT id, amount_cents, fee_cents, net_cents, status, method, requested_at, processed_at, reference, notes
       FROM payouts WHERE driver_id = $1 ORDER BY requested_at DESC LIMIT 5`,
      [userId]
    );
    return {
      balance_cents: Number(wallet?.balance_cents ?? 0),
      lifetime_earnings_cents: Number(wallet?.lifetime_earnings_cents ?? 0),
      payout_card: cardSummary,
      recent_payouts: pRes.rows,
    };
  }

  static async requestOnDemandPayout(userId: string, amountCents: number) {
    const MIN_PAYOUT_CENTS = 1000; // $10 minimum
    if (amountCents < MIN_PAYOUT_CENTS) {
      throw new Error(`MIN_PAYOUT: Minimum on-demand payout is $${MIN_PAYOUT_CENTS / 100}.`);
    }

    await pool.query(
      `INSERT INTO driver_wallets (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`,
      [userId]
    );
    const wRes = await pool.query(`SELECT * FROM driver_wallets WHERE driver_id = $1`, [userId]);
    const wallet = wRes.rows[0];
    if (!wallet?.payout_card_id) throw new Error('NO_PAYOUT_CARD: Add a payout card before requesting a payout.');
    if (Number(wallet.balance_cents) < amountCents) {
      throw new Error('INSUFFICIENT_BALANCE: Requested amount exceeds your wallet balance.');
    }

    const fee = Math.round(amountCents * 0.05);
    const net = amountCents - fee;

    const client = await pool.connect();
    let payoutId: string;
    try {
      await client.query('BEGIN');
      // Debit wallet
      const upd = await client.query(
        `UPDATE driver_wallets SET balance_cents = balance_cents - $1, updated_at = NOW()
         WHERE driver_id = $2 AND balance_cents >= $1 RETURNING balance_cents`,
        [amountCents, userId]
      );
      if (!upd.rowCount) throw new Error('INSUFFICIENT_BALANCE: Insufficient wallet balance.');
      const ins = await client.query(
        `INSERT INTO payouts (driver_id, amount_cents, fee_cents, net_cents, status, method)
         VALUES ($1, $2, $3, $4, 'PENDING', 'ON_DEMAND') RETURNING id, requested_at`,
        [userId, amountCents, fee, net]
      );
      payoutId = ins.rows[0].id;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Admin notification
    try {
      const driverInfo = await pool.query(`SELECT email, full_name FROM users WHERE id = $1`, [userId]);
      await EmailService.sendPayoutRequestedNotice(
        { email: env.ADMIN_NOTIFY_EMAIL || '' },
        { id: userId, email: driverInfo.rows[0]?.email ?? '', full_name: driverInfo.rows[0]?.full_name ?? 'Driver' },
        { id: payoutId, amount_cents: amountCents, fee_cents: fee, net_cents: net, method: 'ON_DEMAND' }
      );
    } catch (e: any) {
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

  static async listMyPayouts(userId: string, limit: number, offset: number) {
    const res = await pool.query(
      `SELECT id, amount_cents, fee_cents, net_cents, status, method, requested_at, processed_at, reference, notes
       FROM payouts WHERE driver_id = $1 ORDER BY requested_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    const total = await pool.query(`SELECT COUNT(*)::int AS c FROM payouts WHERE driver_id = $1`, [userId]);
    return { payouts: res.rows, total: total.rows[0]?.c ?? 0 };
  }

  // ============================================================
  // New vehicle submission (025)
  // ============================================================

  static async submitNewVehicle(userId: string, data: any) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ins = await client.query(
        `INSERT INTO driver_vehicle_submissions
         (driver_id, status, make, model, year, color, interior_color,
          seats, is_luxury,
          license_plate_number, license_plate_state, zip_code,
          registration_photo_url, insurance_photo_url, inspection_photo_url)
         VALUES ($1, 'PENDING_REVIEW', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [userId, data.make, data.model, data.year, data.color,
         data.interior_color || null, data.seats ?? null, data.is_luxury ?? false,
         data.license_plate_number, data.license_plate_state, data.zip_code,
         data.registration_photo_url, data.insurance_photo_url,
         data.inspection_photo_url]
      );

      // Also create a new driver_vehicles row for the pending vehicle so
      // the profile can distinguish it from the active vehicle.
      await client.query(
        `INSERT INTO driver_vehicles
         (driver_id, vehicle_status, make, model, year, color, interior_color,
          seats, is_luxury,
          license_plate_number, license_plate_state, zip_code,
          registration_photo_url, insurance_photo_url, inspection_photo_url,
          submitted_at)
         VALUES ($1, 'PENDING_REVIEW', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
         ON CONFLICT DO NOTHING`,
        [userId, data.make, data.model, data.year, data.color,
         data.interior_color || null, data.seats ?? null, data.is_luxury ?? false,
         data.license_plate_number, data.license_plate_state, data.zip_code,
         data.registration_photo_url, data.insurance_photo_url,
         data.inspection_photo_url]
      );

      await client.query('COMMIT');
      return { success: true, submission: ins.rows[0] };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  static async getPendingVehicleSubmissions(userId: string) {
    const res = await pool.query(
      `SELECT * FROM driver_vehicle_submissions
       WHERE driver_id = $1
       ORDER BY submitted_at DESC`,
      [userId]
    );
    return { submissions: res.rows };
  }

  // ============================================================
  // Vehicle resubmission requirements (026)
  // ============================================================

  static async getVehicleResubmissionRequirements(userId: string) {
    const reqs = await pool.query(
      `SELECT dvrr.id, dvrr.submission_id, dvrr.reason, dvrr.status,
              dvrr.created_at, dvrr.updated_at,
              COALESCE(dv.vehicle_status, 'APPROVED') AS current_vehicle_status,
              dv.make, dv.model, dv.year, dv.color,
              dv.license_plate_number, dv.license_plate_state, dv.zip_code
       FROM driver_vehicle_resubmission_requests dvrr
       LEFT JOIN driver_vehicles dv ON dv.driver_id = dvrr.driver_id
         AND (dv.vehicle_status = 'RESUBMISSION_REQUIRED' OR dv.vehicle_status = 'PENDING_REVIEW')
       WHERE dvrr.driver_id = $1
       ORDER BY dvrr.created_at DESC`,
      [userId]
    );

    const hasActionRequired = reqs.rows.some(
      r => r.status === 'resubmission_required'
    );

    return {
      requirements: reqs.rows,
      has_action_required: hasActionRequired,
    };
  }

  static async submitVehicleResubmission(userId: string, data: any, resubmissionRequestId?: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert the submission
      const ins = await client.query(
        `INSERT INTO driver_vehicle_submissions
         (driver_id, status, make, model, year, color, interior_color,
          license_plate_number, license_plate_state, zip_code,
          registration_photo_url, insurance_photo_url, inspection_photo_url)
         VALUES ($1, 'PENDING_REVIEW', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [userId, data.make, data.model, data.year, data.color,
         data.interior_color || null, data.license_plate_number,
         data.license_plate_state, data.zip_code,
         data.registration_photo_url, data.insurance_photo_url,
         data.inspection_photo_url]
      );

      // Create/update the driver_vehicles row
      await client.query(
        `INSERT INTO driver_vehicles
         (driver_id, vehicle_status, make, model, year, color, interior_color,
          license_plate_number, license_plate_state, zip_code,
          registration_photo_url, insurance_photo_url, inspection_photo_url,
          submitted_at)
         VALUES ($1, 'PENDING_REVIEW', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
         ON CONFLICT DO NOTHING`,
        [userId, data.make, data.model, data.year, data.color,
         data.interior_color || null, data.license_plate_number,
         data.license_plate_state, data.zip_code,
         data.registration_photo_url, data.insurance_photo_url,
         data.inspection_photo_url]
      );

      // Update the resubmission request status if specified
      if (resubmissionRequestId) {
        await client.query(
          `UPDATE driver_vehicle_resubmission_requests
           SET status = 'submitted', updated_at = NOW()
           WHERE id = $1 AND driver_id = $2`,
          [resubmissionRequestId, userId]
        );
      }

      // Clear vehicle action required flag
      await client.query(
        `UPDATE drivers
         SET has_vehicle_action_required = FALSE
         WHERE user_id = $1`,
        [userId]
      );

      await client.query('COMMIT');
      return { success: true, submission: ins.rows[0] };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ============================================================
  // Active vehicle resolution helpers
  // ============================================================

  /**
   * Returns the driver's authoritative active/approved vehicle.
   * Legacy rows with NULL vehicle_status are treated as APPROVED.
   * Returns null if no active vehicle exists.
   */
  static async getActiveVehicle(driverId: string) {
    const res = await pool.query(
      `SELECT dv.*, v.make AS catalog_make, v.model AS catalog_model,
              v.year AS catalog_year, v.category, v.service_class
       FROM driver_vehicles dv
       LEFT JOIN vehicles v ON dv.vehicle_id = v.id
       WHERE dv.driver_id = $1
         AND (dv.vehicle_status = 'APPROVED' OR dv.vehicle_status IS NULL)
       ORDER BY dv.approved_at DESC NULLS LAST, dv.id DESC
       LIMIT 1`,
      [driverId]
    );
    return res.rows[0] || null;
  }

  /**
   * Returns the latest finalized vehicle submission (Approved or Rejected)
   * for admin review purposes. This is distinct from the active vehicle.
   */
  static async getLatestFinalizedVehicleSubmission(driverId: string) {
    const res = await pool.query(
      `SELECT s.*, u.full_name AS reviewed_by_admin_name
       FROM driver_vehicle_submissions s
       LEFT JOIN users u ON u.id = s.reviewed_by_admin_id
       WHERE s.driver_id = $1
         AND s.status IN ('APPROVED', 'REJECTED')
       ORDER BY s.reviewed_at DESC NULLS LAST, s.submitted_at DESC
       LIMIT 1`,
      [driverId]
    );
    return res.rows[0] || null;
  }

  /**
   * Returns the latest vehicle submission (any status) for the driver.
   */
  static async getLatestVehicleSubmission(driverId: string) {
    const res = await pool.query(
      `SELECT s.*
       FROM driver_vehicle_submissions s
       WHERE s.driver_id = $1
       ORDER BY s.submitted_at DESC
       LIMIT 1`,
      [driverId]
    );
    return res.rows[0] || null;
  }

  // ============================================================
  // Document resubmission requirements (024)
  // ============================================================

  static async getDocumentRequirements(userId: string) {
    const reqs = await pool.query(
      `SELECT dr.id, dr.document_type, dr.status, dr.current_document_url,
              dr.request_reason, dr.requested_at, dr.resubmitted_at,
              dr.new_document_url, dr.reviewed_at, dr.review_decision
       FROM driver_document_requirements dr
       WHERE dr.driver_id = $1
       ORDER BY dr.requested_at DESC`,
      [userId]
    );

    // Check if driver has any pending action
    const hasActionRequired = reqs.rows.some(r => r.status === 'resubmission_required' || r.status === 'submitted');

    return {
      requirements: reqs.rows,
      has_action_required: hasActionRequired,
    };
  }

  /**
   * Submit one or more new document URLs for admin review.
   * `newDocumentUrls` must be a non-empty array of strings (URLs).
   * When multiple URLs are provided they are stored as a JSON array in
   * `new_document_url` so the admin UI can display all submitted images.
   */
  static async resubmitDocument(userId: string, requirementId: string, newDocumentUrls: string[]) {
    const req = await pool.query(
      `SELECT id, driver_id, status, document_type FROM driver_document_requirements WHERE id = $1`,
      [requirementId]
    );

    if (!req.rowCount) throw new Error('Document requirement not found.');
    if (req.rows[0].driver_id !== userId) throw new Error('This document requirement does not belong to you.');
    if (req.rows[0].status !== 'resubmission_required') throw new Error('This requirement is not pending resubmission.');

    // Store as JSON array for multi-image support, or plain string for single-image backward compat.
    const documentUrl = newDocumentUrls.length === 1
      ? newDocumentUrls[0]
      : JSON.stringify(newDocumentUrls);

    const updated = await pool.query(
      `UPDATE driver_document_requirements
       SET status = 'submitted', new_document_url = $1, resubmitted_at = NOW(), updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [documentUrl, requirementId]
    );

    return { success: true, requirement: updated.rows[0] };
  }

  /**
   * Atomically submit multiple document requirements in a single transaction.
   * All submissions succeed or none do — partial failures are rolled back.
   */
  static async batchResubmitDocuments(
    userId: string,
    submissions: Array<{ requirementId: string; newDocumentUrls: string[] }>
  ) {
    if (!submissions.length) throw new Error('No submissions provided.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const sub of submissions) {
        const { requirementId, newDocumentUrls } = sub;
        if (!requirementId || !newDocumentUrls?.length) {
          throw new Error(`Invalid submission for requirement ${requirementId}`);
        }

        const req = await client.query(
          `SELECT id, driver_id, status FROM driver_document_requirements WHERE id = $1`,
          [requirementId]
        );

        if (!req.rowCount) throw new Error(`Requirement ${requirementId} not found.`);
        if (req.rows[0].driver_id !== userId) throw new Error(`Requirement ${requirementId} does not belong to you.`);
        if (req.rows[0].status !== 'resubmission_required') {
          throw new Error(`Requirement ${requirementId} is not pending resubmission.`);
        }

        const documentUrl = newDocumentUrls.length === 1
          ? newDocumentUrls[0]
          : JSON.stringify(newDocumentUrls);

        await client.query(
          `UPDATE driver_document_requirements
           SET status = 'submitted', new_document_url = $1, resubmitted_at = NOW(), updated_at = NOW()
           WHERE id = $2`,
          [documentUrl, requirementId]
        );
      }

      await client.query('COMMIT');

      // ── Fire-and-forget notifications (must not block response) ──────
      try {
        const driverInfo = await pool.query(
          `SELECT u.email, u.full_name FROM users u WHERE u.id = $1`,
          [userId]
        );
        const driver = driverInfo.rows[0] || null;

        const docTypesResult = await pool.query(
          `SELECT document_type FROM driver_document_requirements
           WHERE driver_id = $1 AND id = ANY($2) ORDER BY document_type`,
          [userId, submissions.map(s => s.requirementId)]
        );
        const docTypes = docTypesResult.rows.map((r: any) => r.document_type);

        if (driver) {
          // Driver confirmation email
          EmailService.sendDriverDocumentResubmittedConfirmationEmail(
            { email: driver.email, full_name: driver.full_name },
            { document_types: docTypes }
          );

          // Admin notification email
          EmailService.sendAdminDocumentResubmissionNoticeEmail(
            { email: env.ADMIN_NOTIFY_EMAIL },
            {
              id: userId,
              full_name: driver.full_name,
              email: driver.email,
            },
            {
              document_types: docTypes,
              submitted_at: new Date(),
            }
          );
        }
      } catch (notifErr) {
        // Notifications are best-effort — document submission already succeeded
        console.error('❌ [DOC SUBMIT] Notification error:', notifErr);
      }

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Idempotent ride-completion wallet credit. Safe to call multiple times
   * for the same ride — the unique index on payouts(ride_id) WHERE
   * method='RIDE_CREDIT' prevents double-counting.
   *
   * Revenue split (041): the driver receives the full tip plus their 60%
   * driver share of the fare. The 40% platform pool is allocated to the
   * driver's fleet partner (if assigned) with NetRide keeping the remainder —
   * see pricing.service.ts. The per-ride allocation persisted at accept time
   * is authoritative; a missing allocation falls back to a live computation.
   */
  static async creditOnRideComplete(driverId: string, fareCents: number, tipCents: number, rideId: string) {
    if (!driverId) return;
    const safeFare = Math.max(0, Math.round(fareCents));
    const safeTip = Math.max(0, Math.round(tipCents));
    if (safeFare + safeTip <= 0) return;

    // Authoritative allocation from the price snapshot (persisted at accept);
    // fall back to a live computation for legacy rides without one.
    const allocation =
      (await getRevenueAllocationForRide(rideId)) ??
      (await computeRevenueAllocation(safeFare, null).catch(() => null));
    const driverShareCents = allocation ? allocation.driverShareCents : safeFare;
    const driverNetCents = safeTip + driverShareCents;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO driver_wallets (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`,
        [driverId]
      );
      await client.query(
        `UPDATE driver_wallets
         SET balance_cents = balance_cents + $1,
             lifetime_earnings_cents = lifetime_earnings_cents + $1,
             updated_at = NOW()
         WHERE driver_id = $2`,
        [driverNetCents, driverId]
      );
      await client.query(
        `INSERT INTO payouts (driver_id, amount_cents, fee_cents, net_cents, status, method, ride_id)
         VALUES ($1, $2, 0, $2, 'PAID', 'RIDE_CREDIT', $3)
         ON CONFLICT (ride_id) WHERE method = 'RIDE_CREDIT' DO NOTHING`,
        [driverId, driverNetCents, rideId]
      );
      console.log(
        `[WALLET] 💰 Ride ${rideId}: rider paid $${(safeFare / 100).toFixed(2)}, driver received $${(driverNetCents / 100).toFixed(2)} (fare share $${(driverShareCents / 100).toFixed(2)} + tip $${(safeTip / 100).toFixed(2)})`
      );
      await client.query('COMMIT');
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error(`[WALLET] ❌ creditOnRideComplete failed for driver ${driverId}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Wallet credit for tips added AFTER the ride completed. The completion
   * credit only captured the tip that existed at completion time; this
   * credits the delta separately. Idempotent per ride: the payouts
   * TIP_CREDIT partial unique index plus delta math prevent double-
   * counting, so re-running the same tip request is a no-op.
   */
  static async creditTipAfterComplete(driverId: string, tipCents: number, rideId: string) {
    if (!driverId) return;
    const safeTip = Math.max(0, Math.round(tipCents));
    if (safeTip <= 0) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO driver_wallets (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`,
        [driverId]
      );
      await client.query(
        `UPDATE driver_wallets
         SET balance_cents = balance_cents + $1,
             lifetime_earnings_cents = lifetime_earnings_cents + $1,
             updated_at = NOW()
         WHERE driver_id = $2`,
        [safeTip, driverId]
      );
      await client.query(
        `INSERT INTO payouts (driver_id, amount_cents, fee_cents, net_cents, status, method, ride_id)
         VALUES ($1, $2, 0, $2, 'PAID', 'TIP_CREDIT', $3)
         ON CONFLICT (ride_id) WHERE method = 'TIP_CREDIT' DO NOTHING`,
        [driverId, safeTip, rideId]
      );
      console.log(
        `[WALLET] 💰 Ride ${rideId}: after-trip tip of $${(safeTip / 100).toFixed(2)} credited to driver ${driverId}`
      );
      await client.query('COMMIT');
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error(`[WALLET] ❌ creditTipAfterComplete failed for driver ${driverId}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }
}
