import * as dotenv from 'dotenv';

dotenv.config();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as express from 'express';
import helmet from 'helmet';
import { TelephonyGateway } from './telephony/telephony.gateway';

// Import legacy express application
const legacyModule = require('./legacy/index.js');

async function bootstrap() {
  console.log(`[ENV-AUDIT]\ncwd=${process.cwd()}\ngeminiKeyConfigured=${!!process.env.GEMINI_API_KEY}\ngeminiKeyLength=${process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.length : 0}`);
  try {
    const app = await NestFactory.create(AppModule);

    // Enterprise Security Headers (DEF-17)
    app.use(
      helmet({
        contentSecurityPolicy: false, // Prevents breaking WebRTC/WebSocket client signaling in local/dev environments
        crossOriginEmbedderPolicy: false,
      }),
    );

    // Middleware
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());

    // CORS
    const allowedOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
      : ['http://localhost:3000', 'http://127.0.0.1:3000'];

    app.enableCors({
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
          callback(null, true);
        } else {
          callback(new Error('CORS origin denied'), false);
        }
      },
      credentials: true,
    });

    app.enableShutdownHooks();

    // Get underlying Express instance
    const expressInstance = app.getHttpAdapter().getInstance();
    expressInstance.set('trust proxy', 1);

    // Mount legacy routes
    if (legacyModule?.app) {
      expressInstance.use(legacyModule.app);
      console.log('✅ Legacy Express routes mounted');
    }

    // Render provides PORT automatically
    const port = parseInt(process.env.PORT || '4000', 10);

    // Important for Render/Docker deployments
    await app.listen(port, '0.0.0.0');

    console.log(`🚀 Unified Backend running on port ${port}`);

    // Initialize Socket.IO integrations
    try {
      const telephonyGateway = app.get(TelephonyGateway);

      if (telephonyGateway?.server) {
        const io = telephonyGateway.server;

        if (legacyModule?.mountLegacyApp) {
          legacyModule.mountLegacyApp(
            legacyModule.app,
            io,
          );

          console.log(
            '✅ Legacy Service successfully mounted and initialized',
          );
        }
      } else {
        console.warn(
          '⚠️ TelephonyGateway server not available',
        );
      }
    } catch (error) {
      console.error(
        '❌ Legacy Service initialization failed:',
        error,
      );
    }
  } catch (error) {
    console.error(
      '❌ Application bootstrap failed:',
      error,
    );
    process.exit(1);
  }
}

bootstrap();
