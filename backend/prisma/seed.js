// backend/prisma/seed.js
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Since we can't easily pass the URL to PrismaClient in 7 without a lot of ceremony, 
// let's try to use the environment variable which SHOULD work if the client is generated correctly.

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

  console.log('Seeding vehicles...');
  for (const v of vehicles) {
    await prisma.vehicle.create({
      data: v,
    });
  }
  console.log('Seed completed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
