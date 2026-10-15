import {
  Controller,
  Post,
  Get,
  Req,
  Body,
  UnauthorizedException,
  InternalServerErrorException,
  Logger,
  Inject,
  Optional,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { Public } from '../api-gateway/auth.guard';
import { Throttle } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';

@Controller('api/v1/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redisClient?: any,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('login')
  async login(@Body() body: any) {
    const { email, password } = body;
    this.logger.log(`Attempting login for email: ${email}`);

    try {
      if (!email || !password) {
        throw new UnauthorizedException('Email and password are required');
      }

      const user = await this.prisma.user.findUnique({
        where: { email },
        include: { agentProfile: true },
      });

      if (!user) {
        this.logger.warn(`User not found: ${email}`);
        throw new UnauthorizedException('Invalid email or password');
      }

      const isValid = await bcrypt.compare(password, user.passwordHash);

      if (!isValid) {
        this.logger.warn(`Invalid password for user: ${email}`);
        throw new UnauthorizedException('Invalid email or password');
      }

      const payload = {
        sub: user.id,
        userId: user.id,
        agentId: user.agentProfile?.id || user.id,
        email: user.email,
        role: user.role,
        name: user.agentProfile?.name || 'Admin',
        department: user.agentProfile?.department || 'General Support',
      };

      const accessToken = this.jwtService.sign(payload);
      const refreshToken = this.jwtService.sign(payload, { expiresIn: '7d' });
      
      this.logger.log(`Login successful for user: ${email}`);
      return {
        accessToken,
        refreshToken,
        session: {
          id: user.id,
          userId: user.id,
          agentId: user.agentProfile?.id || user.id,
          email: user.email,
          role: user.role,
          name: user.agentProfile?.name || 'Admin',
          department: user.agentProfile?.department || 'General Support',
        },
      };
    } catch (error) {
      this.logger.error(`Login error: ${error.message}`, error.stack);
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new InternalServerErrorException('Failed to process login');
    }
  }

  @Get('me')
  async getProfile(@Req() req: any) {
    if (!req.user) {
      throw new UnauthorizedException('Not authenticated');
    }
    const userId = req.user.userId || req.user.sub || req.user.id;
    let user = null;
    if (userId) {
      try {
        user = await this.prisma.user.findUnique({
          where: { id: userId },
          include: { agentProfile: true },
        });
      } catch (_) {}
    }

    return {
      userId: user ? user.id : userId,
      id: user ? user.id : userId,
      email: user ? user.email : (req.user.email || ''),
      role: user ? user.role : (req.user.role || 'AGENT'),
      name: user?.agentProfile?.name || req.user.name || 'User',
      department: user?.agentProfile?.department || req.user.department || 'General',
      agentId: user?.agentProfile?.id || req.user.agentId,
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Req() req: any) {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7).trim()
      : authHeader;

    if (token && this.redisClient) {
      try {
        await this.redisClient.set(`revoked_token:${token}`, '1', 'EX', 7 * 86400);
      } catch (err: any) {
        this.logger.error(`Failed to blacklist token in redis: ${err.message}`);
      }
    }
    return { success: true, message: 'Logged out successfully' };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('refresh')
  async refresh(@Body() body: any) {
    const { refreshToken } = body;
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    if (this.redisClient) {
      try {
        const isRevoked = await this.redisClient.get(`revoked_token:${refreshToken}`);
        if (isRevoked) {
          throw new UnauthorizedException('Refresh token has been revoked');
        }
      } catch (e) {
        // Continue if redis is unavailable
      }
    }

    try {
      const secret = process.env.JWT_SECRET || 'crm-secure-jwt-secret-key-2026';
      const payload = await this.jwtService.verifyAsync(refreshToken, { secret });

      const newPayload = {
        sub: payload.sub,
        userId: payload.userId,
        agentId: payload.agentId,
        email: payload.email,
        role: payload.role,
        name: payload.name,
        department: payload.department,
      };

      const newAccessToken = this.jwtService.sign(newPayload, { expiresIn: '8h' });
      const newRefreshToken = this.jwtService.sign(newPayload, { expiresIn: '7d' });

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      };
    } catch (err) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('reset-password')
  async resetPassword(@Body() body: any) {
    const { email, token, newPassword } = body;

    // Phase 1: Request password reset link / token
    if (email && !token) {
      // Safe response: Always return success message without revealing account existence
      return {
        success: true,
        message: 'If an account with that email exists, password reset instructions have been sent.',
      };
    }

    // Phase 2: Perform password reset with token
    if (token && newPassword) {
      if (typeof newPassword !== 'string' || newPassword.length < 8) {
        throw new UnauthorizedException('Password must be at least 8 characters long');
      }
      try {
        const secret = process.env.JWT_SECRET || 'crm-secure-jwt-secret-key-2026';
        const decoded = await this.jwtService.verifyAsync(token, { secret });
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await this.prisma.user.update({
          where: { id: decoded.sub || decoded.userId },
          data: { passwordHash: hashedPassword },
        });
        return {
          success: true,
          message: 'Password has been successfully updated.',
        };
      } catch (err) {
        throw new UnauthorizedException('Invalid or expired reset token');
      }
    }

    throw new UnauthorizedException('Invalid reset request');
  }
}
