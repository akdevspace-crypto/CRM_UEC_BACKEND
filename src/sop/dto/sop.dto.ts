import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsNumber,
  IsArray,
  ValidateNested,
  IsUUID,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SopDepartment,
  SopPriority,
  SopExecutionStatus,
  SopTemplateStatus,
  SopRecurrence,
  SopApprovalStatus,
} from '@prisma/client';

export class CreateSopStepDto {
  @IsNumber()
  stepOrder: number;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isMandatory?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresAttachment?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresNotes?: boolean;

  @IsOptional()
  @IsNumber()
  estimatedMinutes?: number;

  @IsOptional()
  @IsString()
  roleRequired?: string;

  @IsOptional()
  validationRules?: any;
}

export class CreateSopTemplateDto {
  @IsString()
  code: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(SopDepartment)
  department: SopDepartment;

  @IsString()
  category: string;

  @IsOptional()
  @IsEnum(SopPriority)
  priority?: SopPriority;

  @IsOptional()
  @IsEnum(SopRecurrence)
  recurrence?: SopRecurrence;

  @IsOptional()
  @IsUUID()
  unitId?: string;

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  escalationHours?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSopStepDto)
  steps?: CreateSopStepDto[];
}

export class UpdateSopTemplateDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(SopDepartment)
  department?: SopDepartment;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsEnum(SopPriority)
  priority?: SopPriority;

  @IsOptional()
  @IsEnum(SopRecurrence)
  recurrence?: SopRecurrence;

  @IsOptional()
  @IsUUID()
  unitId?: string;

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @IsOptional()
  @IsNumber()
  escalationHours?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;
}

export class CreateSopExecutionDto {
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @IsOptional()
  @IsUUID()
  templateVersionId?: string;

  @IsString()
  title: string;

  @IsEnum(SopDepartment)
  department: SopDepartment;

  @IsString()
  category: string;

  @IsOptional()
  @IsEnum(SopPriority)
  priority?: SopPriority;

  @IsOptional()
  @IsUUID()
  unitId?: string;

  @IsOptional()
  @IsUUID()
  assignedAgentId?: string;

  @IsOptional()
  @IsString()
  assignedRole?: string;

  @IsOptional()
  dueDate?: string | Date;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  leadId?: string;

  @IsOptional()
  @IsUUID()
  ticketId?: string;

  @IsOptional()
  @IsUUID()
  callSessionId?: string;

  @IsOptional()
  metadata?: any;
}

export class UpdateSopExecutionDto {
  @IsOptional()
  @IsEnum(SopExecutionStatus)
  status?: SopExecutionStatus;

  @IsOptional()
  @IsUUID()
  assignedAgentId?: string;

  @IsOptional()
  @IsString()
  assignedRole?: string;

  @IsOptional()
  dueDate?: string | Date;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  blockedReason?: string;

  @IsOptional()
  completionEvidence?: any;

  @IsOptional()
  metadata?: any;
}

export class CompleteStepDto {
  @IsBoolean()
  isCompleted: boolean;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  attachmentUrl?: string;
}

export class ReviewSopApprovalDto {
  @IsEnum(SopApprovalStatus)
  status: SopApprovalStatus;

  @IsOptional()
  @IsString()
  comments?: string;
}

export class CreateSopDocumentDto {
  @IsString()
  documentNumber: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(SopDepartment)
  department: SopDepartment;

  @IsString()
  category: string;

  @IsOptional()
  @IsString()
  version?: string;

  @IsOptional()
  @IsString()
  fileUrl?: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsNumber()
  fileSize?: number;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  effectiveDate?: string | Date;

  @IsOptional()
  reviewDate?: string | Date;

  @IsOptional()
  @IsBoolean()
  requiresAcknowledgement?: boolean;

  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class SopHandoffDto {
  @IsUUID()
  executionId: string;

  @IsEnum(SopDepartment)
  toDepartment: SopDepartment;

  @IsString()
  action: string;

  @IsOptional()
  @IsUUID()
  targetAgentId?: string;

  @IsOptional()
  @IsString()
  targetRole?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  metadata?: any;
}

export class SopQueryDto {
  @IsOptional()
  @IsEnum(SopDepartment)
  department?: SopDepartment;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsEnum(SopExecutionStatus)
  status?: SopExecutionStatus;

  @IsOptional()
  @IsEnum(SopPriority)
  priority?: SopPriority;

  @IsOptional()
  @IsUUID()
  unitId?: string;

  @IsOptional()
  @IsUUID()
  assignedAgentId?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  period?: 'today' | 'week' | 'month' | 'all';

  @IsOptional()
  @IsNumber()
  page?: number;

  @IsOptional()
  @IsNumber()
  limit?: number;
}
