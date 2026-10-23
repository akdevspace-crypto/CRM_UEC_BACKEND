import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { EnquiryService } from './enquiry.service';
import {
  UpdateEnquiryClassificationDto,
  CreateLeadFromEnquiryDto,
  SaveCallIntakeDto,
  SaveLiveNotesDto,
  OverrideEmergencyPriorityDto,
  CreateCatalogItemDto,
} from './dto/enquiry.dto';

@Controller('api/v1/enquiry')
export class EnquiryController {
  private readonly logger = new Logger(EnquiryController.name);

  constructor(private readonly enquiryService: EnquiryService) {}

  // 1. Service Catalog & Config
  @Get('catalog')
  async getCatalog(@Query('foundationKey') foundationKey?: string) {
    return await this.enquiryService.getCatalog(foundationKey);
  }

  @Post('catalog')
  async createCatalogItem(@Body() dto: CreateCatalogItemDto, @Req() req: any) {
    return await this.enquiryService.createCatalogItem(dto, req.user);
  }

  @Put('catalog/:id')
  async updateCatalogItem(
    @Param('id') id: string,
    @Body() dto: Partial<CreateCatalogItemDto>,
    @Req() req: any,
  ) {
    return await this.enquiryService.updateCatalogItem(id, dto, req.user);
  }

  @Delete('catalog/:id')
  async deleteCatalogItem(@Param('id') id: string, @Req() req: any) {
    return await this.enquiryService.deleteCatalogItem(id, req.user);
  }

  // 2. Intelligent Omnichannel Conversation Understanding
  @Post('conversations/:id/classify')
  async classifyConversation(
    @Param('id') conversationId: string,
    @Body('text') text?: string,
  ) {
    return await this.enquiryService.classifyConversation(conversationId, text);
  }

  @Patch('conversations/:id/classification')
  async updateConversationClassification(
    @Param('id') conversationId: string,
    @Body() dto: UpdateEnquiryClassificationDto,
    @Req() req: any,
  ) {
    return await this.enquiryService.updateConversationClassification(
      conversationId,
      dto,
      req.user,
    );
  }

  // 3. Lead Creation & Synchronization
  @Post('conversations/:id/lead')
  async createOrSyncLead(
    @Param('id') conversationId: string,
    @Body() dto: CreateLeadFromEnquiryDto,
    @Req() req: any,
  ) {
    return await this.enquiryService.createOrSyncLead(conversationId, dto, req.user);
  }

  // 4. Call Intake Form Persistence
  @Patch('calls/:id/intake')
  async saveCallIntake(
    @Param('id') callSidOrId: string,
    @Body() dto: SaveCallIntakeDto,
    @Req() req: any,
  ) {
    return await this.enquiryService.saveCallIntake(callSidOrId, dto, req.user);
  }

  // 4b. Standalone / Manual Lead Structured Intake Persistence
  @Post('leads/intake')
  async saveStructuredEnquiry(@Body() dto: SaveCallIntakeDto, @Req() req: any) {
    return await this.enquiryService.saveStructuredEnquiryLead(dto, req.user);
  }

  @Patch('leads/:id/intake')
  async updateStructuredEnquiry(
    @Param('id') leadId: string,
    @Body() dto: SaveCallIntakeDto,
    @Req() req: any,
  ) {
    return await this.enquiryService.saveStructuredEnquiryLead(dto, req.user, leadId);
  }

  // 5. Incremental Live Notes Auto-Save
  @Patch('live-notes/:targetType/:id')
  async saveLiveNotes(
    @Param('targetType') targetType: 'call' | 'lead' | 'conversation',
    @Param('id') id: string,
    @Body() dto: SaveLiveNotesDto,
    @Req() req: any,
  ) {
    return await this.enquiryService.saveLiveNotes(targetType, id, dto, req.user);
  }

  // 6. Ambulance Priority Override & Audit
  @Post('emergency/override')
  async overrideEmergencyPriority(
    @Body() dto: OverrideEmergencyPriorityDto,
    @Req() req: any,
  ) {
    return await this.enquiryService.overrideEmergencyPriority(dto, req.user);
  }
}
