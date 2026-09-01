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

  await q('migrations_applied', `SELECT version FROM migrations_applied ORDER BY applied_at DESC LIMIT 5`);
  await q('sponsor_portal_accounts cols', `SELECT column_name FROM information_schema.columns WHERE table_name='sponsor_portal_accounts' ORDER BY ordinal_position`);
  await q('sponsors exists', `SELECT COUNT(*)::int AS n FROM sponsors`);
  await q('sponsor users', `SELECT COUNT(*)::int AS n FROM users WHERE role='SPONSOR'`);
  await q('partners exists', `SELECT COUNT(*)::int AS n FROM partners`);
  await q('partners cols', `SELECT column_name FROM information_schema.columns WHERE table_name='partners' ORDER BY ordinal_position`);
  await q('partner users', `SELECT COUNT(*)::int AS n FROM users WHERE role='PARTNER'`);
  await q('fleet_partners exists', `SELECT COUNT(*)::int AS n FROM fleet_partners`);
  await q('fleet cols', `SELECT column_name FROM information_schema.columns WHERE table_name='fleet_partners' ORDER BY ordinal_position`);
  await q('ride_price_snapshots cols', `SELECT column_name FROM information_schema.columns WHERE table_name='ride_price_snapshots' ORDER BY ordinal_position`);
  await q('users role enum', `SELECT unnest(enum_range(NULL::user_role))::text AS role`);
  await q('special_redemptions', `SELECT COUNT(*)::int AS n FROM special_redemptions`);
  await q('verification_codes', `SELECT COUNT(*)::int AS n FROM verification_codes`);
  await q('audit_events', `SELECT COUNT(*)::int AS n FROM audit_events`);
  await pool.end();
})();