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

const app = express();

app.use(cors());
app.use(express.json());

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

app.use(errorHandler);

export default app;