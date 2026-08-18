import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { IS_PUBLIC_KEY } from './public.decorator';

export const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const isLoopbackAddress = (value: string | undefined): boolean => {
  const address = (value || '').toLowerCase().replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) {
      return true;
    }
    if (!this.config.ingestToken) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const bearerOk = safeEqual(request.headers.authorization || '', `Bearer ${this.config.ingestToken}`);
    const cookie = this.readCookie(request.headers.cookie || '', 'ai_monitor_session');
    const cookieOk = isLoopbackAddress(request.socket.remoteAddress)
      && safeEqual(cookie, this.dashboardCookie());
    if (!bearerOk && !cookieOk) throw new UnauthorizedException('invalid ingest token');

    if (cookieOk && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin?.replace(/\/$/, '');
      if (origin && origin !== `http://${this.config.host}:${this.config.port}`) {
        throw new ForbiddenException('invalid dashboard origin');
      }
    }
    return true;
  }

  dashboardCookie(): string {
    return createHmac('sha256', this.config.ingestToken).update('ai-monitor-dashboard').digest('hex');
  }

  private readCookie(header: string, name: string): string {
    for (const part of header.split(';')) {
      const [key, ...rest] = part.trim().split('=');
      if (key === name) return decodeURIComponent(rest.join('='));
    }
    return '';
  }
}
