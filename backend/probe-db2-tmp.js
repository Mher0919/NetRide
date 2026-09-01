require('dotenv').config({ path: 'C:/Users/mmkrt/OneDrive/Desktop/NetRide/backend/.env' });
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = async (label, sql) => {
    try {
      const r = await pool.query(sql);
      console.log(label + ':', JSON.stringify(r.rows));
    } catch (e) {
      console.log(label + ': ERROR ' + e.message);
    }
  };
  await q('migrations_applied cols', `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='migrations_applied' ORDER BY ordinal_position`);
  await q('migrations_applied rows', `SELECT * FROM migrations_applied ORDER BY applied_at DESC LIMIT 6`);
  await q('promo_codes', `SELECT COUNT(*)::int AS n FROM promo_codes`);
  await q('partner_commissions', `SELECT COUNT(*)::int AS n FROM partner_commissions`);
  await q('promo_usage', `SELECT COUNT(*)::int AS n FROM promo_usage`);
  await q('fleet drivers', `SELECT COUNT(*)::int AS n FROM drivers WHERE fleet_id IS NOT NULL`);
  await q('snapshots w/ fleet', `SELECT COUNT(*)::int AS n FROM ride_price_snapshots WHERE driver_fleet_id IS NOT NULL`);
  await q('audit_events schema', `SELECT column_name FROM information_schema.columns WHERE table_name='audit_events' ORDER BY ordinal_position`);
  await q('users full_name of partner', `SELECT id, email, full_name, role FROM users WHERE email LIKE '%partner%' OR full_name ILIKE '%partner%' LIMIT 5`);
  await q('the one partner', `SELECT id, name, contact_email, status, commission_rate FROM partners`);
  await q('the one fleet', `SELECT id, name, contact_email, platform_share_percent, is_active FROM fleet_partners`);
  await pool.end();
})();