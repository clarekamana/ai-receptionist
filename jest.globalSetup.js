const { execSync } = require('child_process');

module.exports = async () => {
  // Relative to prisma/schema.prisma's directory, resolves to prisma/test.db.
  const DATABASE_URL = 'file:./test.db';
  process.env.DATABASE_URL = DATABASE_URL;
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL },
  });
};
