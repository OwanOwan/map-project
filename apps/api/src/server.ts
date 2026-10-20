import { buildApp } from './app.js';
import { env } from './config/env.js';

async function start() {
  try {
    const app = await buildApp({
      logger: {
        level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      },
    });

    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    console.log(`🚀 SafetyMap API server running at http://localhost:${env.PORT}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
