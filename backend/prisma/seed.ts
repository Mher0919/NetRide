// backend/prisma/seed.ts
import { PrismaClient, VehicleCategory } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Clear existing vehicles to avoid duplicates if re-seeding
  await prisma.vehicle.deleteMany({});

  const categories = [
    { make: 'NetRide', model: 'Economy', year: 2026, category: VehicleCategory.ECONOMY },
    { make: 'NetRide', model: 'Extra', year: 2026, category: VehicleCategory.EXTRA },
    { make: 'NetRide', model: 'Lux', year: 2026, category: VehicleCategory.LUX },
    { make: 'NetRide', model: 'SUV Lux', year: 2026, category: VehicleCategory.SUV_LUX },
    { make: 'NetRide', model: 'Premier', year: 2026, category: VehicleCategory.PREMIER },
  ];

  console.log('Seeding ride categories...');
  for (const v of categories) {
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
