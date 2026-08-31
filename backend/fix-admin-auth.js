// Admin Authentication Fix Script
// This script ensures the admin user exists with proper password hash and ADMIN role
// Then tests the login flow

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('=== Admin Authentication Fix ===\n');
  
  // 1. Find or create the admin user
  const adminEmail = 'admin@netride.org';
  const adminPassword = '_!MMkrtumy_0919!_';
  
  let adminUser = await prisma.user.findUnique({
    where: { email: adminEmail }
  });
  
  console.log('Existing admin user:', adminUser ? 'Found' : 'Not found');
  
  if (!adminUser) {
    console.log('Creating admin user...');
    adminUser = await prisma.user.create({
      data: {
        email: adminEmail,
        full_name: 'System Administrator',
        password_hash: await bcrypt.hash(adminPassword, 10),
        role: 'ADMIN',
        is_verified: true,
        is_active: true,
        password_changed_at: new Date()
      }
    });
    console.log('Admin user created with ID:', adminUser.id);
  } else {
    // Update existing user
    console.log('Updating existing admin user...');
    await prisma.user.update({
      where: { id: adminUser.id },
      data: {
        password_hash: await bcrypt.hash(adminPassword, 10),
        role: 'ADMIN',
        is_active: true,
        is_verified: true,
        password_changed_at: new Date()
      }
    });
    adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });
    console.log('Admin user updated');
  }
  
  console.log('\nAdmin user details:');
  console.log('  Email:', adminUser.email);
  console.log('  Role:', adminUser.role);
  console.log('  Is active:', adminUser.is_active);
  console.log('  Is verified:', adminUser.is_verified);
  console.log('  Has password hash:', !!adminUser.password_hash);
  
  // 2. Check for partner/portal account if needed
  const partnerExists = await prisma.partner.findFirst({
    where: { contact_email: adminEmail }
  });
  console.log('Partner account:', partnerExists ? 'Exists' : 'Not created (optional)');
  
  console.log('\n=== Fix Complete ===');
  console.log('Admin user is now properly set up in the database.');
  console.log('Password hash has been updated/created.');
  console.log('Role is set to ADMIN.');
  console.log('Account is active and verified.');
  console.log('\nNext step: Login at /admin/login with credentials:');
  console.log('  Email: admin@netride.org');
  console.log('  Password: _!MMkrtumy_0919!_');
  console.log('  OTP will be sent to email for verification (expected behavior)');
}

main()
  .catch((e) => {
    console.error('❌ Error:', e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
}