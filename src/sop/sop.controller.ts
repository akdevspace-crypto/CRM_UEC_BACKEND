import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Param,
  Query,
  Body,
  Req,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { SopService } from './sop.service';
import { Public } from '../api-gateway/auth.guard';
import {
  CreateSopTemplateDto,
  UpdateSopTemplateDto,
  CreateSopExecutionDto,
  UpdateSopExecutionDto,
  CompleteStepDto,
  ReviewSopApprovalDto,
  CreateSopDocumentDto,
  SopHandoffDto,
  SopQueryDto,
  CreateStaffProfileDto,
  UpdateStaffProfileDto,
  StaffQueryDto,
  CreateStaffRequirementDto,
  UpdateStaffRequirementDto,
  TransitionSalesStageDto,
  CreateCcrComplaintDto,
  UpdateCcrComplaintDto,
  SubmitSopDailyReportDto,
} from './dto/sop.dto';

@Controller('api/v1/sop')
export class SopController {
  private readonly logger = new Logger(SopController.name);

  constructor(private readonly sopService: SopService) {}

  private extractUser(req: any) {
    if (req?.user) return req.user;
    // Fallback: headers or system actor if session token not injected
    return {
      userId: req?.headers['x-user-id'] || 'system-admin',
      id: req?.headers['x-user-id'] || 'system-admin',
      email: req?.headers['x-user-email'] || 'admin@eldercare.com',
      role: req?.headers['x-user-role'] || 'SUPER_ADMIN',
    };
  }

  // ==========================================
  // DASHBOARD & DAILY OPERATIONS
  // ==========================================

  @Get('overview')
  async getOverview(@Query() query: SopQueryDto, @Req() req: any) {
    return this.sopService.getOverview(query, this.extractUser(req));
  }

  @Get('daily-operations')
  async getDailyOperations(@Query() query: SopQueryDto, @Req() req: any) {
    return this.sopService.getDailyOperations(query, this.extractUser(req));
  }

  // ==========================================
  // TEMPLATES & BUILDER
  // ==========================================

  @Get('templates')
  async getTemplates(@Query() query: SopQueryDto, @Req() req: any) {
    return this.sopService.getTemplates(query, this.extractUser(req));
  }

  @Get('templates/:id')
  async getTemplateById(@Param('id') id: string, @Req() req: any) {
    return this.sopService.getTemplateById(id, this.extractUser(req));
  }

  @Post('templates')
  async createTemplate(@Body() dto: CreateSopTemplateDto, @Req() req: any) {
    return this.sopService.createTemplate(dto, this.extractUser(req));
  }

  @Put('templates/:id')
  async updateTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateSopTemplateDto,
    @Req() req: any,
  ) {
    return this.sopService.updateTemplate(id, dto, this.extractUser(req));
  }

  @Post('templates/:id/versions')
  async publishNewVersion(
    @Param('id') id: string,
    @Body() body: { steps: any[]; changelog: string },
    @Req() req: any,
  ) {
    return this.sopService.publishNewVersion(
      id,
      body.steps,
      body.changelog,
      this.extractUser(req),
    );
  }

  // ==========================================
  // EXECUTIONS / TASKS
  // ==========================================

  @Get('executions')
  async getExecutions(@Query() query: SopQueryDto, @Req() req: any) {
    return this.sopService.getExecutions(query, this.extractUser(req));
  }

  @Get('executions/:id')
  async getExecutionById(@Param('id') id: string, @Req() req: any) {
    return this.sopService.getExecutionById(id, this.extractUser(req));
  }

  @Post('executions')
  async createExecution(@Body() dto: CreateSopExecutionDto, @Req() req: any) {
    return this.sopService.createExecution(dto, this.extractUser(req));
  }

  @Patch('executions/:id')
  async updateExecution(
    @Param('id') id: string,
    @Body() dto: UpdateSopExecutionDto,
    @Req() req: any,
  ) {
    return this.sopService.updateExecution(id, dto, this.extractUser(req));
  }

  @Post('executions/:id/steps/:stepId/complete')
  async completeStep(
    @Param('id') executionId: string,
    @Param('stepId') stepId: string,
    @Body() dto: CompleteStepDto,
    @Req() req: any,
  ) {
    return this.sopService.completeStep(
      executionId,
      stepId,
      dto,
      this.extractUser(req),
    );
  }

  @Post('executions/:id/submit-approval')
  async submitForApproval(@Param('id') id: string, @Req() req: any) {
    return this.sopService.submitForApproval(id, this.extractUser(req));
  }

  @Post('executions/:id/review')
  async reviewApproval(
    @Param('id') id: string,
    @Body() dto: ReviewSopApprovalDto,
    @Req() req: any,
  ) {
    return this.sopService.reviewApproval(id, dto, this.extractUser(req));
  }

  // ==========================================
  // CROSS-DEPARTMENT HANDOFFS
  // ==========================================

  @Post('handoff')
  async triggerHandoff(@Body() dto: SopHandoffDto, @Req() req: any) {
    return this.sopService.triggerHandoff(dto, this.extractUser(req));
  }

  // ==========================================
  // SOP DOCUMENTS & ACKNOWLEDGEMENTS
  // ==========================================

  @Get('documents')
  async getDocuments(@Query() query: SopQueryDto, @Req() req: any) {
    return this.sopService.getDocuments(query, this.extractUser(req));
  }

  @Post('documents')
  async createDocument(@Body() dto: CreateSopDocumentDto, @Req() req: any) {
    return this.sopService.createDocument(dto, this.extractUser(req));
  }

  @Post('documents/:id/acknowledge')
  async acknowledgeDocument(@Param('id') id: string, @Req() req: any) {
    const ipAddress = req?.ip || req?.socket?.remoteAddress;
    const userAgent = req?.headers?.['user-agent'];
    return this.sopService.acknowledgeDocument(
      id,
      this.extractUser(req),
      ipAddress,
      userAgent,
    );
  }

  // ==========================================
  // REPORTS & AUDIT TRAIL
  // ==========================================

  @Get('reports')
  async getReports(@Query() query: SopQueryDto, @Req() req: any) {
    return this.sopService.getReports(query, this.extractUser(req));
  }

  // ==========================================
  // SEED INITIAL TEMPLATES
  // ==========================================

  @Public()
  @Post('seed')
  async seedTemplates(@Req() req: any) {
    return this.sopService.seedDefaultTemplates(this.extractUser(req));
  }

  // ==========================================
  // PHASE 16: HR STAFF MANAGEMENT ENDPOINTS
  // ==========================================

  @Get('staff')
  async getStaffProfiles(@Query() query: StaffQueryDto, @Req() req: any) {
    return this.sopService.getStaffProfiles(query, this.extractUser(req));
  }

  @Get('staff/stock')
  async getStaffStock(@Query('unitId') unitId: string) {
    return this.sopService.getStaffStockByCategory(unitId);
  }

  @Get('staff/:id')
  async getStaffProfileById(@Param('id') id: string, @Req() req: any) {
    return this.sopService.getStaffProfileById(id, this.extractUser(req));
  }

  @Post('staff')
  async createStaffProfile(@Body() dto: CreateStaffProfileDto, @Req() req: any) {
    return this.sopService.createStaffProfile(dto, this.extractUser(req));
  }

  @Patch('staff/:id')
  async updateStaffProfile(
    @Param('id') id: string,
    @Body() dto: UpdateStaffProfileDto,
    @Req() req: any,
  ) {
    return this.sopService.updateStaffProfile(id, dto, this.extractUser(req));
  }

  @Post('staff/:id/second-hr-confirm')
  async secondHrConfirm(@Param('id') id: string, @Req() req: any) {
    return this.sopService.secondHrConfirm(id, this.extractUser(req));
  }

  @Post('staff/:id/three-day-followup')
  async recordStaffThreeDayFollowup(
    @Param('id') id: string,
    @Body() body: { notes: string; successful: boolean },
    @Req() req: any,
  ) {
    return this.sopService.recordStaffThreeDayFollowup(id, body, this.extractUser(req));
  }

  // ==========================================
  // PHASE 16: WANTED STAFF REQUIREMENTS
  // ==========================================

  @Get('requirements')
  async getStaffRequirements(
    @Query('status') status: string,
    @Query('unitId') unitId: string,
  ) {
    return this.sopService.getStaffRequirements(status, unitId);
  }

  @Post('requirements')
  async createStaffRequirement(
    @Body() dto: CreateStaffRequirementDto,
    @Req() req: any,
  ) {
    return this.sopService.createStaffRequirement(dto, this.extractUser(req));
  }

  @Patch('requirements/:id')
  async updateStaffRequirement(
    @Param('id') id: string,
    @Body() dto: UpdateStaffRequirementDto,
    @Req() req: any,
  ) {
    return this.sopService.updateStaffRequirement(id, dto, this.extractUser(req));
  }

  // ==========================================
  // PHASE 16: SALES PIPELINE & TARGETS
  // ==========================================

  @Post('sales/transition')
  async transitionSalesStage(
    @Body() dto: TransitionSalesStageDto,
    @Req() req: any,
  ) {
    return this.sopService.transitionSalesStage(dto, this.extractUser(req));
  }

  @Get('sales/pipeline/:leadId')
  async getSalesPipelineHistory(@Param('leadId') leadId: string) {
    return this.sopService.getSalesPipelineHistory(leadId);
  }

  @Get('sales/targets/:agentId')
  async getSalesTargetStatus(@Param('agentId') agentId: string) {
    return this.sopService.getSalesTargetStatus(agentId);
  }

  // ==========================================
  // PHASE 16: CCR COMPLAINT MANAGEMENT
  // ==========================================

  @Post('ccr/complaints')
  async createCcrComplaint(
    @Body() dto: CreateCcrComplaintDto,
    @Req() req: any,
  ) {
    return this.sopService.createCcrComplaint(dto, this.extractUser(req));
  }

  @Patch('ccr/complaints/:id')
  async updateCcrComplaint(
    @Param('id') id: string,
    @Body() dto: UpdateCcrComplaintDto,
    @Req() req: any,
  ) {
    return this.sopService.updateCcrComplaint(id, dto, this.extractUser(req));
  }

  // ==========================================
  // PHASE 16: SOP DAILY REPORTS
  // ==========================================

  @Post('daily-reports')
  async submitDailyReport(
    @Body() dto: SubmitSopDailyReportDto,
    @Req() req: any,
  ) {
    return this.sopService.submitDailyReport(dto, this.extractUser(req));
  }

  @Get('daily-reports')
  async getDailyReports(
    @Query('department') department: any,
    @Query('date') date: string,
  ) {
    return this.sopService.getDailyReports(department, date);
  }
}

