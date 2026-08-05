const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const url = env.DIRECT_DATABASE_URL || env.DATABASE_URL;
const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '036_pricing_profiles.sql'), 'utf8');

(async () => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
    const res = await client.query(
      `SELECT code, label, base_fare, per_km_rate, per_minute_rate, minimum_fare,
              booking_fee, service_fee_rate, tax_rate, max_demand_multiplier,
              peak_time_multiplier, off_peak_multiplier, weather_multiplier,
              location_multiplier, fleet_multiplier, active
       FROM pricing_profiles ORDER BY code`,
    );
    console.log('MIGRATION OK — pricing_profiles rows:');
    for (const r of res.rows) console.log(JSON.stringify(r));
  } finally {
    await client.end();
  }
})().catch((err) => { console.error('MIGRATION FAILED:', err.message); process.exit(1); });
