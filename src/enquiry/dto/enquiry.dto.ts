import { IsString, IsOptional, IsArray, IsBoolean, IsNumber, IsEnum } from 'class-validator';
import { EnquiryCategory, Priority } from '@prisma/client';

export class UpdateEnquiryClassificationDto {
  @IsOptional()
  @IsString()
  foundation?: string;

  @IsOptional()
  @IsEnum(EnquiryCategory)
  enquiryCategory?: EnquiryCategory;

  @IsOptional()
  @IsString()
  primaryService?: string;

  @IsOptional()
  @IsArray()
  subServices?: string[];

  @IsOptional()
  @IsString()
  patientName?: string;

  @IsOptional()
  @IsNumber()
  patientAge?: number;

  @IsOptional()
  @IsString()
  patientConditions?: string;

  @IsOptional()
  @IsString()
  patientMobility?: string;

  @IsOptional()
  @IsString()
  engagementType?: string;

  @IsOptional()
  @IsString()
  careDurationCategory?: string;

  @IsOptional()
  @IsString()
  careDuration?: string;

  @IsOptional()
  @IsString()
  careSchedule?: string;

  @IsOptional()
  @IsString()
  serviceAddress?: string;

  @IsOptional()
  @IsString()
  cityDistrict?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsString()
  pickupLocation?: string;

  @IsOptional()
  @IsString()
  destinationLocation?: string;

  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  @IsOptional()
  @IsNumber()
  classificationConfidence?: number;

  @IsOptional()
  @IsBoolean()
  isClassificationConfirmed?: boolean;

  @IsOptional()
  @IsArray()
  missingInfo?: string[];

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  emergencyOverrideReason?: string;
}

export class CreateLeadFromEnquiryDto {
  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  foundation?: string;

  @IsOptional()
  @IsString()
  serviceCategory?: string;

  @IsOptional()
  @IsEnum(EnquiryCategory)
  enquiryCategory?: EnquiryCategory;

  @IsOptional()
  @IsString()
  primaryService?: string;

  @IsOptional()
  @IsArray()
  subServices?: string[];

  @IsOptional()
  @IsString()
  patientName?: string;

  @IsOptional()
  @IsNumber()
  patientAge?: number;

  @IsOptional()
  @IsString()
  patientConditions?: string;

  @IsOptional()
  @IsString()
  patientMobility?: string;

  @IsOptional()
  @IsString()
  engagementType?: string;

  @IsOptional()
  @IsString()
  careDurationCategory?: string;

  @IsOptional()
  @IsString()
  careDuration?: string;

  @IsOptional()
  @IsString()
  careSchedule?: string;

  @IsOptional()
  @IsString()
  serviceAddress?: string;

  @IsOptional()
  @IsString()
  cityDistrict?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsOptional()
  @IsString()
  pickupLocation?: string;

  @IsOptional()
  @IsString()
  destinationLocation?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  assignedAgentId?: string;

  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;
}

export class SaveCallIntakeDto {
  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsString()
  enquirerName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  foundation?: string;

  @IsOptional()
  @IsString()
  serviceCategory?: string;

  @IsOptional()
  @IsEnum(EnquiryCategory)
  enquiryCategory?: EnquiryCategory;

  @IsOptional()
  @IsString()
  primaryService?: string;

  @IsOptional()
  @IsArray()
  subServices?: string[];

  @IsOptional()
  @IsString()
  patientName?: string;

  @IsOptional()
  @IsNumber()
  patientAge?: number;

  @IsOptional()
  @IsString()
  patientConditions?: string;

  @IsOptional()
  @IsString()
  patientMobility?: string;

  @IsOptional()
  @IsString()
  engagementType?: string;

  @IsOptional()
  @IsString()
  careDurationCategory?: string;

  @IsOptional()
  @IsString()
  careDuration?: string;

  @IsOptional()
  @IsString()
  careSchedule?: string;

  @IsOptional()
  @IsString()
  serviceAddress?: string;

  @IsOptional()
  @IsString()
  cityDistrict?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsOptional()
  @IsString()
  pickupLocation?: string;

  @IsOptional()
  @IsString()
  destinationLocation?: string;

  @IsOptional()
  @IsString()
  liveNotes?: string;

  @IsOptional()
  @IsString()
  callOutcome?: string;

  @IsOptional()
  @IsString()
  followupDate?: string;

  @IsOptional()
  @IsBoolean()
  callbackRequired?: boolean;

  @IsOptional()
  @IsString()
  callbackPriority?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  status?: string;
}

export class SaveLiveNotesDto {
  @IsString()
  text: string;

  @IsOptional()
  @IsString()
  authorName?: string;

  @IsOptional()
  @IsString()
  authorId?: string;
}

export class OverrideEmergencyPriorityDto {
  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsEnum(Priority)
  newPriority: Priority;

  @IsString()
  overrideReason: string;
}

export class CreateCatalogItemDto {
  @IsString()
  foundationKey: string;

  @IsString()
  foundationName: string;

  @IsString()
  category: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  subServices?: string[];

  @IsOptional()
  @IsBoolean()
  isEmergency?: boolean;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;
}
