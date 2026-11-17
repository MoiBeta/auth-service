import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // Health check, polled by Docker.
  @SkipThrottle()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
