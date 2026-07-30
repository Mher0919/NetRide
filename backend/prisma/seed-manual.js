// backend/prisma/seed-manual.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  const vehicles = [
    { make: 'Toyota', model: 'Camry', year: 2022, category: 'ECONOMY', service_class: 'CORE' },
    { make: 'Toyota', model: 'Corolla', year: 2022, category: 'ECONOMY', service_class: 'CORE' },
    { make: 'Honda', model: 'Accord', year: 2022, category: 'ECONOMY', service_class: 'CORE' },
    { make: 'Honda', model: 'Civic', year: 2022, category: 'ECONOMY', service_class: 'CORE' },
    { make: 'Toyota', model: 'Rav4', year: 2022, category: 'SUV', service_class: 'CORE' },
    { make: 'Honda', model: 'CR-V', year: 2022, category: 'SUV', service_class: 'CORE' },
    { make: 'Toyota', model: 'Sienna', year: 2022, category: 'VAN', service_class: 'CORE' },
    { make: 'Honda', model: 'Odyssey', year: 2022, category: 'VAN', service_class: 'CORE' },

    { make: 'Tesla', model: 'Model 3', year: 2023, category: 'EXTRA', service_class: 'ELITE' },
    { make: 'Tesla', model: 'Model Y', year: 2023, category: 'SUV', service_class: 'ELITE' },
    { make: 'BMW', model: '3 Series', year: 2023, category: 'PREMIUM', service_class: 'ELITE' },
    { make: 'Mercedes-Benz', model: 'C-Class', year: 2023, category: 'PREMIUM', service_class: 'ELITE' },

    { make: 'Tesla', model: 'Model S', year: 2023, category: 'PREMIUM', service_class: 'PRESTIGE' },
    { make: 'Tesla', model: 'Model X', year: 2023, category: 'SUV_LUX', service_class: 'PRESTIGE' },
    { make: 'Mercedes-Benz', model: 'E-Class', year: 2023, category: 'PREMIUM', service_class: 'PRESTIGE' },
    { make: 'BMW', model: '7 Series', year: 2023, category: 'PREMIUM', service_class: 'PRESTIGE' },
    { make: 'Cadillac', model: 'Escalade', year: 2023, category: 'SUV_LUX', service_class: 'PRESTIGE' },
    { make: 'Mercedes-Benz', model: 'S-Class', year: 2023, category: 'LUX', service_class: 'PRESTIGE' },
  ];

  console.log('Seeding vehicles manually using pg...');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const v of vehicles) {
      await client.query(
        'INSERT INTO vehicles (id, make, model, year, category, service_class) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)',
        [v.make, v.model, v.year, v.category, v.service_class]
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
