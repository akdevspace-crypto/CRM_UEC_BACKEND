import { Controller, Get, Patch, Post, Body, Query, UseGuards, Logger, BadRequestException } from '@nestjs/common';
import { CapacityService, TelephonyCapacityConfig } from './capacity.service';
import { AuthGuard } from '../../api-gateway/auth.guard';
import { RolesGuard, Roles } from '../../api-gateway/roles.guard';

@Controller('telephony/capacity')
export class CapacityController {
  private readonly logger = new Logger(CapacityController.name);

  constructor(private readonly capacityService: CapacityService) {}

  @Get('config')
  @UseGuards(AuthGuard)
  async getConfig(@Query('provider') provider = 'vobiz') {
    const config = await this.capacityService.getCapacityConfig(provider);
    return {
      success: true,
      config,
    };
  }

  @Patch('config')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async updateConfig(
    @Body() body: Partial<TelephonyCapacityConfig> & { provider?: string },
  ) {
    const provider = body.provider || 'vobiz';
    if (body.totalChannels !== undefined && body.totalChannels < 1) {
      throw new BadRequestException('totalChannels must be at least 1');
    }
    if (body.inboundReserved !== undefined && body.inboundReserved < 0) {
      throw new BadRequestException('inboundReserved cannot be negative');
    }

    const updated = await this.capacityService.updateCapacityConfig(provider, body);
    return {
      success: true,
      message: `Capacity configuration updated for provider ${provider}`,
      config: updated,
    };
  }

  @Get('status')
  async getStatus(@Query('provider') provider = 'vobiz') {
    const status = await this.capacityService.getCapacityStatus(provider);
    return {
      success: true,
      data: status,
    };
  }

  @Post('reconcile')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN', 'ADMIN')
  async triggerReconcile(@Query('provider') provider = 'vobiz') {
    await this.capacityService.reconcileStaleReservations(provider);
    const status = await this.capacityService.getCapacityStatus(provider);
    return {
      success: true,
      message: 'Reconciliation completed',
      currentStatus: status,
    };
  }
}
