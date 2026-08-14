process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.PORT = '0';
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', esModuleInterop: true } });

(async () => {
  const { DriverEligibilityService } = require('C:/Users/mmkrt/OneDrive/Desktop/NetRide/backend/src/services/driver-eligibility.service');
  const result = await DriverEligibilityService.checkEligibility('5c874b6b-d4f8-43c2-951d-62a29ec3240b');
  console.log('ELIGIBILITY:', JSON.stringify(result));
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
