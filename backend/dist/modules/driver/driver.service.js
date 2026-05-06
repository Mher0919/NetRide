"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DriverService = void 0;
// backend/src/modules/driver/driver.service.ts
const database_1 = require("../../config/database");
const email_service_1 = require("../../services/email.service");
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
            // 1. Update User
            await client.query(`UPDATE users 
         SET phone_number = $1, date_of_birth = $2, profile_image_url = $3, updated_at = NOW() 
         WHERE id = $4`, [data.personalInfo.phone_number, data.personalInfo.date_of_birth, data.personalInfo.profile_image_url, userId]);
            // 2. Ensure Driver Record Exists and Update
            // Check if driver record exists
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
            await client.query(`INSERT INTO driver_vehicles (driver_id, vehicle_id, license_plate_number, license_plate_photo_url, car_photo_urls, color, interior_color)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [userId, data.vehicle.vehicle_id, data.vehicle.license_plate_number, data.vehicle.license_plate_photo_url, data.vehicle.car_photo_urls, data.vehicle.color, data.vehicle.interior_color]);
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
    static async updateProfile(userId, data) {
        const client = await database_1.pool.connect();
        try {
            await client.query('BEGIN');
            // 1. Update User if provided (DOB update via this method is now restricted by logic)
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
            // ... rest of method
            // 2. Update Driver info if provided
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
            // 3. Update Vehicle if provided (assuming one vehicle for now)
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
            // 1. Reset verification status and update DOB if provided
            if (data.date_of_birth) {
                await client.query('UPDATE users SET is_verified = false, date_of_birth = $1 WHERE id = $2', [data.date_of_birth, userId]);
            }
            else {
                await client.query('UPDATE users SET is_verified = false WHERE id = $1', [userId]);
            }
            // 2. Update Driver and set inactive
            const driverUpdateFields = ['is_active = false', "background_check_status = 'PENDING'"];
            const driverUpdateValues = [];
            let i = 1;
            // Enforcement: To update age/license, both photos must be provided if one is being updated
            // or at least both must exist in the final state. 
            // For simplicity in the request, we expect both to be sent if they are requesting verification.
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
            // 3. Trigger email
            const profile = await this.getProfile(userId);
            // Validation: Ensure profile picture exists before sending to admin
            if (!profile.profile_image_url) {
                throw new Error('Profile picture is mandatory. Please upload one in your profile.');
            }
            // We can reuse the registration notice template or create a new one
            // For now, let's reuse it as it contains all required info for manual verify
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
}
exports.DriverService = DriverService;
//# sourceMappingURL=driver.service.js.map