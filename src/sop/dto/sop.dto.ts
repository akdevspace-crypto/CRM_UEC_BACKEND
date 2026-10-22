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
  Priority,
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

// ==========================================
// PHASE 16 DTOs: HR, SALES, DATA ENTRY, CCR & QUEUE
// ==========================================

export class CreateStaffProfileDto {
  @IsString()
  name: string;

  @IsString()
  phone: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  gender?: string;

  @IsString()
  category: string; // 'CAREGIVER', 'NURSE', 'ICU_NURSE', 'PHYSIOTHERAPIST', 'DEMENTIA_CARE', 'BEDRIDDEN_CARE'

  @IsOptional()
  @IsString()
  classification?: string; // 'GOOD', 'NORMAL', 'BAD', 'REJECTED'

  @IsOptional()
  @IsString()
  qualifications?: string;

  @IsOptional()
  @IsNumber()
  experienceYears?: number;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  preferredShift?: string;

  @IsOptional()
  @IsNumber()
  dailyRate?: number;

  @IsOptional()
  @IsNumber()
  monthlySalary?: number;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  emergencyContact?: string;

  @IsOptional()
  @IsString()
  idProofType?: string;

  @IsOptional()
  @IsString()
  idProofNumber?: string;

  @IsOptional()
  @IsBoolean()
  policeVerificationDone?: boolean;

  @IsOptional()
  @IsBoolean()
  medicalFitnessDone?: boolean;

  @IsOptional()
  documents?: any[];

  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class UpdateStaffProfileDto {
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
  category?: string;

  @IsOptional()
  @IsString()
  classification?: string;

  @IsOptional()
  @IsString()
  verificationStatus?: string;

  @IsOptional()
  @IsString()
  qualifications?: string;

  @IsOptional()
  @IsNumber()
  experienceYears?: number;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  preferredShift?: string;

  @IsOptional()
  @IsNumber()
  dailyRate?: number;

  @IsOptional()
  @IsNumber()
  monthlySalary?: number;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @IsString()
  currentAssignmentId?: string;

  @IsOptional()
  @IsString()
  alternateAssignmentId?: string;

  @IsOptional()
  @IsBoolean()
  policeVerificationDone?: boolean;

  @IsOptional()
  @IsBoolean()
  medicalFitnessDone?: boolean;

  @IsOptional()
  documents?: any[];

  @IsOptional()
  threeDayFollowupDone?: boolean;

  @IsOptional()
  @IsString()
  threeDayFollowupNotes?: string;
}

export class StaffQueryDto {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  classification?: string;

  @IsOptional()
  @IsString()
  verificationStatus?: string;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @IsUUID()
  unitId?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsNumber()
  page?: number;

  @IsOptional()
  @IsNumber()
  limit?: number;
}

export class CreateStaffRequirementDto {
  @IsString()
  category: string;

  @IsOptional()
  @IsString()
  qualificationRequired?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsUUID()
  unitId?: string;

  @IsOptional()
  @IsNumber()
  openPositions?: number;

  @IsOptional()
  @IsString()
  urgency?: string; // 'CRITICAL', 'HIGH', 'NORMAL'

  @IsString()
  requiredByDate: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateStaffRequirementDto {
  @IsOptional()
  @IsNumber()
  fulfilledPositions?: number;

  @IsOptional()
  @IsString()
  status?: string; // 'OPEN', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED'

  @IsOptional()
  @IsString()
  notes?: string;
}

export class TransitionSalesStageDto {
  @IsUUID()
  leadId: string;

  @IsString()
  stage: string;

  @IsOptional()
  @IsString()
  previousStage?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsNumber()
  tariffAmount?: number;

  @IsOptional()
  @IsNumber()
  officeServiceCharge?: number;

  @IsOptional()
  @IsString()
  paymentStatus?: string;

  @IsOptional()
  @IsString()
  matchedStaffId?: string;

  @IsOptional()
  @IsString()
  alternateStaffId?: string;

  @IsOptional()
  nextActionDate?: string | Date;

  @IsOptional()
  metadata?: any;
}

export class CreateCcrComplaintDto {
  @IsUUID()
  customerId: string;

  @IsString()
  category: string;

  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  @IsOptional()
  @IsString()
  severity?: string; // 'EMERGENCY', 'ABOVE_NORMAL', 'NORMAL'

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  affectedStaffId?: string;

  @IsOptional()
  @IsString()
  investigationNotes?: string;

  @IsOptional()
  @IsUUID()
  agentId?: string;
}

export class UpdateCcrComplaintDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  resolution?: string;

  @IsOptional()
  @IsString()
  severity?: string;

  @IsOptional()
  @IsString()
  replacementStaffId?: string;

  @IsOptional()
  @IsString()
  investigationNotes?: string;

  @IsOptional()
  @IsString()
  managerApprovalStatus?: string; // 'PENDING', 'APPROVED', 'REJECTED'

  @IsOptional()
  threeDayFollowupDate?: string | Date;

  @IsOptional()
  @IsString()
  threeDayFollowupNotes?: string;

  @IsOptional()
  tenDayFollowupDate?: string | Date;

  @IsOptional()
  @IsString()
  tenDayFollowupNotes?: string;

  @IsOptional()
  @IsNumber()
  customerSatisfactionScore?: number;

  @IsOptional()
  @IsString()
  testimonialNotes?: string;

  @IsOptional()
  @IsString()
  referralNotes?: string;
}

export class SubmitSopDailyReportDto {
  @IsEnum(SopDepartment)
  department: SopDepartment;

  @IsString()
  reportDate: string; // YYYY-MM-DD

  @IsOptional()
  @IsUUID()
  unitId?: string;

  metrics: Record<string, any>;
}

export class QueueConfigDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsNumber()
  priority?: number;

  @IsOptional()
  @IsArray()
  skillsRequired?: string[];

  @IsOptional()
  @IsArray()
  serviceCategories?: string[];

  @IsOptional()
  businessHours?: any;

  @IsOptional()
  @IsNumber()
  maxWaitSeconds?: number;

  @IsOptional()
  @IsNumber()
  agentRingTimeoutSeconds?: number;

  @IsOptional()
  @IsUUID()
  overflowQueueId?: string;

  @IsOptional()
  @IsString()
  assignmentStrategy?: 'LONGEST_IDLE' | 'ROUND_ROBIN' | 'SKILL_BASED';
}

