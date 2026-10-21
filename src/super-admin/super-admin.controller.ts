import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { SuperAdminService } from './super-admin.service';
import type { EnquiriesQuery } from './super-admin.service';
import { Roles } from '../api-gateway/roles.guard';

@Controller('api/v1/super-admin')
export class SuperAdminController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  /**
   * Phase 1: Global Active Agents Indicator
   * Accessible by SUPER_ADMIN (and ADMIN)
   */
  @Get('active-agents')
  @Roles('SUPER_ADMIN', 'ADMIN')
  async getActiveAgents() {
    return this.superAdminService.getActiveAgents();
  }

  /**
   * Phase 2: Total Omnichannel Enquiries Chart Data
   * Accessible by SUPER_ADMIN, ADMIN, SUPERVISOR
   */
  @Get('omnichannel-enquiries')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPERVISOR')
  async getOmnichannelEnquiries(@Query() query: EnquiriesQuery) {
    return this.superAdminService.getOmnichannelEnquiries(query);
  }

  /**
   * Phase 3: Platform Overview
   */
  @Get('overview')
  @Roles('SUPER_ADMIN')
  async getPlatformOverview() {
    return this.superAdminService.getPlatformOverview();
  }

  /**
   * Phase 3: Database Safe Diagnostic Health
   */
  @Get('database-health')
  @Roles('SUPER_ADMIN')
  async getDatabaseHealth() {
    return this.superAdminService.getDatabaseHealth();
  }

  /**
   * Phase 3 & 4: Integrations Inventory with Masked Secrets
   */
  @Get('integrations')
  @Roles('SUPER_ADMIN')
  async getIntegrations(@Query('unitId') unitId?: string) {
    return this.superAdminService.getIntegrations(unitId);
  }

  /**
   * Phase 3 & 4: Bounded Integration Health Check
   */
  @Post('integrations/:provider/test')
  @Roles('SUPER_ADMIN')
  async testIntegration(
    @Param('provider') provider: string,
    @Query('unitId') unitId: string,
    @Req() req: any,
  ) {
    const actorEmail = req.user?.email || 'super_admin@eldercare.com';
    return this.superAdminService.testIntegration(provider, unitId, actorEmail);
  }

  /**
   * Phase 4: Securely Update Integration Settings
   */
  @Put('integrations/:provider')
  @Roles('SUPER_ADMIN')
  async updateIntegration(
    @Param('provider') provider: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    const actorEmail = req.user?.email || 'super_admin@eldercare.com';
    return this.superAdminService.updateIntegration(provider, body, actorEmail);
  }

  /**
   * Phase 5: Multi-Unit Management Endpoints
   */
  @Get('units')
  @Roles('SUPER_ADMIN')
  async getBusinessUnits() {
    return this.superAdminService.getBusinessUnits();
  }

  @Post('units')
  @Roles('SUPER_ADMIN')
  async createBusinessUnit(@Body() body: any, @Req() req: any) {
    const actorEmail = req.user?.email || 'super_admin@eldercare.com';
    return this.superAdminService.createBusinessUnit(body, actorEmail);
  }

  @Put('units/:id')
  @Roles('SUPER_ADMIN')
  async updateBusinessUnit(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    const actorEmail = req.user?.email || 'super_admin@eldercare.com';
    return this.superAdminService.updateBusinessUnit(id, body, actorEmail);
  }

  /**
   * Phase 3 & 5: Administrative Audit Logs
   */
  @Get('audit-logs')
  @Roles('SUPER_ADMIN')
  async getAuditLogs(@Query('limit') limit?: string) {
    const take = limit ? parseInt(limit, 10) : 50;
    return this.superAdminService.getAuditLogs(take);
  }
}
