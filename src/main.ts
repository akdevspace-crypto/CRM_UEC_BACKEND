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
    const app = await NestFactory.create(AppModule, { rawBody: true });

    // Enterprise Security Headers (DEF-17)
    app.use(
      helmet({
        contentSecurityPolicy: false, // Prevents breaking WebRTC/WebSocket client signaling in local/dev environments
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' },
      }),
    );

    // Middleware with exact raw body preservation for HMAC signature verification
    app.use(express.urlencoded({ extended: true }));
    app.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );

    // CORS Configuration
    const configuredOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
      : [];

    const defaultOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://crm-uec-frontend.onrender.com',
    ];

    const allowedOrigins = [...defaultOrigins, ...configuredOrigins];

    app.enableCors({
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        if (!origin) {
          return callback(null, true);
        }

        if (
          allowedOrigins.includes(origin) ||
          allowedOrigins.includes('*') ||
          origin.endsWith('.onrender.com') ||
          origin.includes('localhost') ||
          origin.includes('127.0.0.1')
        ) {
          return callback(null, true);
        }

        return callback(null, true);
      },
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Accept',
        'X-Requested-With',
        'x-vobiz-signature',
        'x-signature',
        'x-hub-signature-256',
        'Cache-Control',
        'Pragma',
      ],
      exposedHeaders: ['Content-Range', 'X-Content-Range'],
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
