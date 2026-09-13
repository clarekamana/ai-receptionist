// Relative to prisma/schema.prisma's directory (not process cwd), so this
// resolves to ai-receptionist-backend/prisma/test.db.
process.env.DATABASE_URL = 'file:./test.db';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.TWILIO_AUTH_TOKEN = 'test-twilio-auth-token';
process.env.PUBLIC_BASE_URL = 'https://example-test.ngrok.io';
