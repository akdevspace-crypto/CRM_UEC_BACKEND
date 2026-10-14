import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { BookingService } from './booking.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { AppointmentStatus } from '@prisma/client';

@Controller('appointments')
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
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    if (!startDate || !endDate) throw new BadRequestException('startDate and endDate are required');
    return this.bookingService.getCalendar(startDate, endDate);
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
  async getPatientAppointments(@Param('customerId') customerId: string) {
    return this.bookingService.getUpcomingAppointments(customerId);
  }

  @Patch(':id/reschedule')
  async rescheduleAppointment(
    @Param('id') id: string,
    @Body('newStartTime') newStartTime: string,
    @Body('duration') duration: number,
    @Body('reason') reason?: string,
  ) {
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
    @Body('reason') reason?: string,
  ) {
    return this.bookingService.cancelAppointment(id, reason);
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body('status') status: AppointmentStatus,
  ) {
    return this.bookingService.updateStatus(id, status);
  }
}
