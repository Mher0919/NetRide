/**
 * Admin Verification Flow Tester
 * 
 * This script:
 * 1. Checks the admin user exists in DB with correct password
 * 2. Tests the login flow (password + OTP if needed)
 * 3. Verifies the token is valid
 */

const http = require('http');

const API_BASE = 'http://127.0.0.1:3000/api';

function makeRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log('=== Admin Verification Flow Test ===\n');

  // SECURITY: never hard-code credentials. Export ADMIN_TEST_EMAIL /
  // ADMIN_TEST_PASSWORD in your shell before running this script.
  const adminEmail = process.env.ADMIN_TEST_EMAIL;
  const adminPassword = process.env.ADMIN_TEST_PASSWORD;
  if (!adminEmail || !adminPassword) {
    console.error('Set ADMIN_TEST_EMAIL and ADMIN_TEST_PASSWORD before running this script.');
    process.exit(1);
  }

  // Step 1: Try password login (this will trigger OTP for admin)
  console.log('Step 1: Attempting admin password login...');
  const loginResult = await makeRequest('/auth/login-password', 'POST', {
    email: adminEmail,
    password: adminPassword,
    trusted_device_token: undefined
  });
  
  console.log(`Response status: ${loginResult.status}`);
  console.log(`Response data:`, JSON.stringify(loginResult.data, null, 2));
  
  if (loginResult.status !== 200) {
    console.log('\n❌ Login failed. This is expected if:');
    console.log('   - Admin user not set up in DB with password hash');
    console.log('   - OTP was sent to email and not yet verified');
    console.log('   - Password is incorrect');
    return;
  }
  
  const { user, token, otp_required, password_expired } = loginResult.data;
  console.log('\nLogin result:');
  console.log('  - User:', user ? user.email : 'null');
  console.log('  - Token:', token ? 'provided' : 'null');
  console.log('  - OTP required:', otp_required);
  console.log('  - Password expired:', password_expired);
  
  if (otp_required) {
    console.log('\n✓ OTP was required (expected for admin without trusted device)');
    console.log('   - OTP has been sent to admin@netride.org');
    console.log('   - Please check email for the 6-digit code');
    console.log('\nStep 2: Would need to verify OTP via /auth/admin/verify-2fa');
    console.log('         This requires the actual OTP code from the email.');
  } else if (token) {
    console.log('\n✓ Login successful! Token received.');
    // Verify the token
    const verifyResult = await makeRequest('/auth/verify-token', 'POST', { token });
    console.log('Token verification:', verifyResult.status === 200 ? '✓ Valid' : '✗ Invalid');
  }
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});