import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Public } from '../auth/public.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { ChannelsService } from '../channels/channels.service';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../database/database.service';

@Controller()
export class DashboardController {
  constructor(
    private readonly config: AppConfigService,
    private readonly auth: AuthGuard,
    private readonly database: DatabaseService,
    private readonly channels: ChannelsService,
  ) {}

  @Get()
  @Public()
  index(@Res() response: Response): void {
    const indexPath = join(this.config.webDistPath, 'index.html');
    if (!existsSync(indexPath)) {
      response.status(503).type('text/plain').send('Dashboard is not built. Run npm run build.');
      return;
    }
    if (this.config.ingestToken) {
      response.cookie('ai_monitor_session', this.auth.dashboardCookie(), {
        httpOnly: true,
        sameSite: 'strict',
        secure: false,
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    );
    response.type('html').send(readFileSync(indexPath, 'utf8'));
  }

  @Get('api/health')
  @Public()
  async health() {
    return {
      ok: true,
      db: this.config.dbPath,
      channels: this.channels.availableChannels().length,
      stats: this.database.stats(),
    };
  }
}
