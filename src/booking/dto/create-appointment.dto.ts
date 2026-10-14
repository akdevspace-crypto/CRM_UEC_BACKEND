import { IsString, IsNotEmpty, IsOptional, IsDateString, IsInt, IsEnum } from 'class-validator';
import { BookingSource } from '@prisma/client';

export class CreateAppointmentDto {
  @IsString()
  @IsOptional()
  customerId?: string;

  @IsString()
  @IsOptional()
  leadId?: string;

  @IsString()
  @IsOptional()
  callSessionId?: string;

  @IsString()
  @IsOptional()
  doctorId?: string;

  @IsString()
  @IsOptional()
  assignedAgentId?: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsOptional()
  treatment?: string;

  @IsDateString()
  @IsNotEmpty()
  date: string;

  @IsDateString()
  @IsNotEmpty()
  startTime: string;

  @IsInt()
  @IsNotEmpty()
  duration: number;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsEnum(BookingSource)
  @IsOptional()
  bookingSource?: BookingSource;

  @IsString()
  @IsOptional()
  notes?: string;
}
