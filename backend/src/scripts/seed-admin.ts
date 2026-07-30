import { PrismaClient, UserRole, VerificationStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminPassword = await bcrypt.hash('AdminPassword123!', 10);
  const userPassword = await bcrypt.hash('password123', 10);

  console.log('🌱 Seeding Admin User...');
  const admin = await prisma.user.upsert({
    where: { email: 'admin@netride.com' },
    update: {},
    create: {
      email: 'admin@netride.com',
      full_name: 'System Admin',
      password_hash: adminPassword,
      role: UserRole.ADMIN,
      is_verified: true,
      verification_status: VerificationStatus.VERIFIED,
    },
  });
  console.log('✅ Admin User created:', admin.email);

  console.log('🌱 Seeding Test Rider...');
  await prisma.user.upsert({
    where: { email: 'rider@NetRide.dev' },
    update: {},
    create: {
      email: 'rider@NetRide.dev',
      full_name: 'Test Rider',
      password_hash: userPassword,
      role: UserRole.RIDER,
      verification_status: VerificationStatus.VERIFIED,
    },
  });

  console.log('🌱 Seeding Test Driver...');
  const driverUser = await prisma.user.upsert({
    where: { email: 'driver@NetRide.dev' },
    update: {},
    create: {
      email: 'driver@NetRide.dev',
      full_name: 'Test Driver',
      password_hash: userPassword,
      role: UserRole.DRIVER,
      verification_status: VerificationStatus.VERIFIED,
    },
  });

  await prisma.driver.upsert({
    where: { user_id: driverUser.id },
    update: {},
    create: {
      user_id: driverUser.id,
      license_number: 'LIC123456',
      license_photo_url: 'https://placehold.co/600x400?text=License+Front',
      license_photo_back_url: 'https://placehold.co/600x400?text=License+Back',
      insurance_photo_url: 'https://placehold.co/600x400?text=Insurance',
      registration_photo_url: 'https://placehold.co/600x400?text=Registration',
    },
  });

  console.log('✅ Test users seeded (password: password123).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
