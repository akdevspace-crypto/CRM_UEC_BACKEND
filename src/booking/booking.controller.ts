import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  Req,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { BookingService } from './booking.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { AppointmentStatus } from '@prisma/client';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller(['api/v1/appointments', 'appointments'])
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Get('availability')
  async checkAvailability(
    @Query('doctorId') doctorId: string,
    @Query('date') date: string,
    @Query('duration') duration: string,
  ) {
    return this.bookingService.checkAvailability(
      doctorId,
      date,
      parseInt(duration) || 30,
    );
  }

  @Get('next-available')
  async getNextAvailableSlot(
    @Query('doctorId') doctorId: string,
    @Query('date') date: string,
    @Query('preferredStartTime') preferredStartTime: string,
    @Query('duration') duration: string,
  ) {
    if (!doctorId || !date || !preferredStartTime) {
       throw new BadRequestException('doctorId, date, and preferredStartTime are required');
    }
    return this.bookingService.getNextAvailableSlot(
      doctorId,
      date,
      preferredStartTime,
      parseInt(duration) || 30,
    );
  }

  @Get('calendar')
  async getCalendar(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const now = new Date();
    const start = startDate || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end = endDate || new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();
    return this.bookingService.getCalendar(start, end);
  }

  @Post()
  async createAppointment(@Body() dto: CreateAppointmentDto) {
    return this.bookingService.createAppointment(dto);
  }

  @Get()
  async getAllAppointments() {
    return this.bookingService.getAllAppointments();
  }

  @Get('doctor/:doctorId')
  async getDoctorSchedule(
    @Param('doctorId') doctorId: string,
    @Query('date') date: string,
  ) {
    return this.bookingService.getDoctorSchedule(doctorId, date);
  }

  @Get('patient/:customerId')
  async getPatientAppointments(@Param('customerId') customerId: string, @Req() req: any) {
    if (!UUID_REGEX.test(customerId)) {
      throw new NotFoundException('Patient record not found');
    }
    const user = req?.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER', 'HR'].includes(user.role);
    if (!isElevated && user && !['AGENT', 'SALES_AGENT'].includes(user.role)) {
      throw new ForbiddenException('Forbidden: Insufficient permissions to view patient records');
    }
    return this.bookingService.getUpcomingAppointments(customerId);
  }

  @Patch(':id/reschedule')
  async rescheduleAppointment(
    @Param('id') id: string,
    @Body('newStartTime') newStartTime: string,
    @Body('duration') duration: number,
    @Body('reason') reason?: string,
  ) {
    if (!UUID_REGEX.test(id)) {
      throw new NotFoundException('Appointment not found');
    }
    return this.bookingService.rescheduleAppointment(
      id,
      newStartTime,
      duration,
      reason,
    );
  }

  @Patch(':id/cancel')
  async cancelAppointment(
    @Param('id') id: string,
    @Req() req: any,
    @Body('reason') reason?: string,
  ) {
    if (!UUID_REGEX.test(id)) {
      throw new NotFoundException('Appointment not found');
    }
    return this.bookingService.cancelAppointment(id, reason, req?.user);
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body('status') status: AppointmentStatus,
  ) {
    return this.bookingService.updateStatus(id, status);
  }
}

@Controller('calendar')
export class CalendarController {
  constructor(private readonly bookingService: BookingService) {}

  @Get()
  async getCalendar(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const now = new Date();
    const start = startDate || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end = endDate || new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();
    return this.bookingService.getCalendar(start, end);
  }
}
