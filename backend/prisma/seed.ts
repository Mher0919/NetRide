// backend/prisma/seed.ts
import { PrismaClient, VehicleCategory } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const vehicles = [
    { make: 'Tesla', model: 'Model 3', year: 2023, category: VehicleCategory.ECONOMY },
    { make: 'Tesla', model: 'Model Y', year: 2023, category: VehicleCategory.SUV },
    { make: 'Tesla', model: 'Model S', year: 2023, category: VehicleCategory.PREMIUM },
    { make: 'Toyota', model: 'Camry', year: 2022, category: VehicleCategory.ECONOMY },
    { make: 'Toyota', model: 'Rav4', year: 2022, category: VehicleCategory.SUV },
    { make: 'Toyota', model: 'Sienna', year: 2022, category: VehicleCategory.VAN },
    { make: 'Honda', model: 'Accord', year: 2022, category: VehicleCategory.ECONOMY },
    { make: 'Honda', model: 'CR-V', year: 2022, category: VehicleCategory.SUV },
    { make: 'Honda', model: 'Odyssey', year: 2022, category: VehicleCategory.VAN },
    { make: 'Mercedes-Benz', model: 'E-Class', year: 2023, category: VehicleCategory.PREMIUM },
    { make: 'BMW', model: '5 Series', year: 2023, category: VehicleCategory.PREMIUM },
    { make: 'Cadillac', model: 'Escalade', year: 2023, category: VehicleCategory.SUV },
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
