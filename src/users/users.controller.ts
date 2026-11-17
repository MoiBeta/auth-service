import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { InternalApiKeyGuard } from './guards/internal-api-key.guard';

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  async findAll(@Req() req: Request & { user: AuthenticatedUser }) {
    const requester = await this.usersService.findById(req.user.userId);
    if (requester.role !== 'ADMIN') {
      throw new ForbiddenException();
    }
    return this.usersService.findAll();
  }

  // Used by other services (habit-service) to validate that a user exists.
  // Not rate limited: every call comes from the same IP, the calling service.
  @SkipThrottle()
  @Get(':id')
  @UseGuards(InternalApiKeyGuard)
  async findById(@Param('id') id: string) {
    return this.usersService.findById(id);
  }
}
