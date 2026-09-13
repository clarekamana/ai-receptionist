import express from 'express';
import cors from 'cors';
import { errorHandler } from './middlewares/error.middleware';

import authRoutes from './routes/auth.routes';
import onboardingRoutes from './routes/onboarding.routes';
import dashboardRoutes from './routes/dashboard.routes';
import bottleneckRoutes from './routes/bottleneck.routes';
import knowledgeRoutes from './routes/knowledge.routes';
import escalationRoutes from './routes/escalation.routes';
import customersRoutes from './routes/customers.routes';
import callsRoutes from './routes/calls.routes';
import notificationsRoutes from './routes/notifications.routes';
import settingsRoutes from './routes/settings.routes';
import telephonyRoutes from './routes/telephony.routes';
import phoneProvisioningRoutes from './routes/phoneProvisioning.routes';
import publicBusinessRoutes from './routes/publicBusiness.routes';
import appCallRoutes from './calls/call.routes';

const app = express();

app.use(cors());
app.use(express.json());
// Twilio (and most telephony providers) POST webhooks as form-encoded, not
// JSON. express.json() and express.urlencoded() each only act on requests
// whose Content-Type matches their own kind, so registering both globally
// is safe and doesn't change behavior for existing JSON routes.
app.use(express.urlencoded({ extended: false }));

// Routes Mount
app.use('/api/auth', authRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/bottleneck', bottleneckRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/escalation', escalationRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/calls', callsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/settings', settingsRoutes);
// Public, unauthenticated — Mwakire's customer-facing business discovery.
// Read-only; see publicBusiness.controller.ts for the exact allowlisted
// fields exposed.
app.use('/api/businesses', publicBusinessRoutes);
// Mwakire's in-app (WebRTC, not Twilio) customer-to-AI call lifecycle. See
// src/calls/call.routes.ts for exactly what's public vs call-token-gated.
app.use('/api/app-calls', appCallRoutes);
// JWT-authenticated owner-facing number provisioning. Mounted before the
// webhook router below (both share the /api/telephony prefix) so it's
// matched first — Express falls through to the next app.use() when a
// router finds no matching route internally, so the order isn't strictly
// required for correctness, but registering the more specific path first
// avoids relying on that fallthrough.
app.use('/api/telephony/numbers', phoneProvisioningRoutes);
// Public, unauthenticated — gated by Twilio signature verification instead
// of the JWT `authenticate` middleware used by every other route above.
app.use('/api/telephony', telephonyRoutes);

app.use(errorHandler);

export default app;