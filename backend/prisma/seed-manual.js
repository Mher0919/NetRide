// backend/prisma/seed-manual.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  const vehicles = [
    { make: 'Tesla', model: 'Model 3', year: 2023, category: 'ECONOMY' },
    { make: 'Tesla', model: 'Model Y', year: 2023, category: 'SUV' },
    { make: 'Tesla', model: 'Model S', year: 2023, category: 'PREMIUM' },
    { make: 'Toyota', model: 'Camry', year: 2022, category: 'ECONOMY' },
    { make: 'Toyota', model: 'Rav4', year: 2022, category: 'SUV' },
    { make: 'Toyota', model: 'Sienna', year: 2022, category: 'VAN' },
    { make: 'Honda', model: 'Accord', year: 2022, category: 'ECONOMY' },
    { make: 'Honda', model: 'CR-V', year: 2022, category: 'SUV' },
    { make: 'Honda', model: 'Odyssey', year: 2022, category: 'VAN' },
    { make: 'Mercedes-Benz', model: 'E-Class', year: 2023, category: 'PREMIUM' },
    { make: 'BMW', model: '5 Series', year: 2023, category: 'PREMIUM' },
    { make: 'Cadillac', model: 'Escalade', year: 2023, category: 'SUV' },
  ];

  console.log('Seeding vehicles manually using pg...');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const v of vehicles) {
      await client.query(
        'INSERT INTO "Vehicle" (id, make, model, year, category) VALUES (gen_random_uuid(), $1, $2, $3, $4)',
        [v.make, v.model, v.year, v.category]
      );
    }
    await client.query('COMMIT');
    console.log('Seed completed successfully.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
