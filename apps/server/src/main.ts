import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { config as loadEnvironment } from 'dotenv';
import { resolve } from 'node:path';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';

loadEnvironment({ path: resolve(__dirname, '../../../.env'), quiet: true });

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(AppConfigService);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useStaticAssets(config.webDistPath, { prefix: '/', index: false });
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
  Logger.log(`AI Monitor is running at http://${config.host}:${config.port}`, 'Bootstrap');
}

void bootstrap();
