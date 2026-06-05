import { Controller, Post, Body, Get, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthGuard } from '@nestjs/passport';
import { RefreshTokenGuard } from './guards/refresh-token.guard';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { RefreshTokenUser } from './interfaces/refresh-token-user.interface';
import { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @ApiOperation({ summary: 'Registrar usuario' })
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto.name, dto.email, dto.password);
  }

  @ApiOperation({ summary: 'Iniciar sesión' })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @ApiOperation({ summary: 'Obtener información del usuario autenticado' })
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  me(@Req() req: Request & { user: AuthenticatedUser }) {
    return this.authService.getMe(req.user.userId);
  }

  @ApiOperation({ summary: 'Actualizar tokens de autenticación' })
  @ApiBearerAuth()
  @UseGuards(RefreshTokenGuard)
  @Post('refresh')
  refresh(@Req() req: Request & { user: RefreshTokenUser }) {
    return this.authService.refreshTokens(
      req.user.userId,
      req.user.refreshToken,
    );
  }
}
