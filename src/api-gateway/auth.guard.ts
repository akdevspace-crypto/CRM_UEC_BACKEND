import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  SetMetadata,
  Inject,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    @Optional() @Inject('REDIS_CLIENT') private readonly redisClient?: any,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    if (!request || !request.headers) {
      return true;
    }

    const authHeader = request.headers['authorization'] || request.headers['Authorization'];

    if (!authHeader) {
      throw new UnauthorizedException('JWT Token missing');
    }

    let token = authHeader;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }

    if (!token) {
      throw new UnauthorizedException('JWT Token missing');
    }

    if (this.redisClient) {
      try {
        const isRevoked = await this.redisClient.get(`revoked_token:${token}`);
        if (isRevoked) {
          throw new UnauthorizedException('Token has been revoked');
        }
      } catch (err) {
        if (err instanceof UnauthorizedException) throw err;
      }
    }

    try {
      const secret = process.env.JWT_SECRET || 'crm-secure-jwt-secret-key-2026';
      const verifyOptions: any = { secret };
      if (process.env.JWT_ISSUER) verifyOptions.issuer = process.env.JWT_ISSUER;
      if (process.env.JWT_AUDIENCE) verifyOptions.audience = process.env.JWT_AUDIENCE;

      const payload = await this.jwtService.verifyAsync(token, verifyOptions);
      if (!payload || (!payload.sub && !payload.userId && !payload.id)) {
        throw new UnauthorizedException('Token missing valid subject/userId claim');
      }
      request.user = payload;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
