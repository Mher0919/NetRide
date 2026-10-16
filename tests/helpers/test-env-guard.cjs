// tests/helpers/test-env-guard.cjs
//
// Safety interlock for scripts that WRITE to the database or Redis (E2E
// harnesses, fixture seeds, cleanup scripts). Refuses to run when
// NODE_ENV=production so a test harness can never mutate a production
// environment by accident.
//
// Point DATABASE_URL / DIRECT_DATABASE_URL / REDIS_URL at a dedicated test
// database. See tests/docs/TEST_DATA_POLICY.md.
if (process.env.NODE_ENV === 'production') {
  console.error(
    '❌ Refusing to run: NODE_ENV=production. E2E tests and fixture seeds must ' +
      'target a non-production environment. See tests/docs/TEST_DATA_POLICY.md.',
  );
  process.exit(1);
}
