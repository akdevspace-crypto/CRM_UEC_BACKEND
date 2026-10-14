import { Controller, Post, Body, UnauthorizedException, InternalServerErrorException, Logger } from '@nestjs/common';
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
}
