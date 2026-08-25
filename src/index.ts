import app from './app';
import { ENV } from './config/env';

app.listen(ENV.PORT, () => {
  console.log(`AI Receptionist Backend running on port ${ENV.PORT}`);
});