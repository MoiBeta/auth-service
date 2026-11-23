import { Controller, Post, Body, Get, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { SetPasswordDto } from './dto/set-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RefreshTokenGuard } from './guards/refresh-token.guard';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { RefreshTokenUser } from './interfaces/refresh-token-user.interface';
import { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RATE_LIMITS } from '../rate-limit';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @ApiOperation({ summary: 'Registrar usuario' })
  @Throttle({ default: RATE_LIMITS.register })
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto.name, dto.email, dto.password);
  }

  @ApiOperation({ summary: 'Iniciar sesión' })
  @Throttle({ default: RATE_LIMITS.login })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @ApiOperation({ summary: 'Iniciar sesión o registrarse con Google' })
  @Throttle({ default: RATE_LIMITS.login })
  @HttpCode(HttpStatus.OK)
  @Post('google')
  loginWithGoogle(@Body() dto: GoogleLoginDto) {
    return this.authService.loginWithGoogle(dto.idToken);
  }

  @ApiOperation({ summary: 'Obtener información del usuario autenticado' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: Request & { user: AuthenticatedUser }) {
    return this.authService.getMe(req.user.userId);
  }

  @ApiOperation({ summary: 'Verificar el correo con el código enviado' })
  @ApiBearerAuth()
  @Throttle({ default: RATE_LIMITS.emailCode })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('email/verify')
  verifyEmail(
    @Req() req: Request & { user: AuthenticatedUser },
    @Body() dto: VerifyEmailDto,
  ) {
    return this.authService.verifyEmail(req.user.userId, dto.code);
  }

  @ApiOperation({ summary: 'Enviar un nuevo código de verificación' })
  @ApiBearerAuth()
  @Throttle({ default: RATE_LIMITS.emailCode })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('email/resend')
  resendEmailCode(@Req() req: Request & { user: AuthenticatedUser }) {
    return this.authService.resendEmailCode(req.user.userId);
  }

  @ApiOperation({
    summary: 'Añadir contraseña a una cuenta que no tiene (creada con Google)',
  })
  @ApiBearerAuth()
  @Throttle({ default: RATE_LIMITS.login })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('password')
  setPassword(
    @Req() req: Request & { user: AuthenticatedUser },
    @Body() dto: SetPasswordDto,
  ) {
    return this.authService.setPassword(
      req.user.userId,
      req.user.credentialsVersion,
      dto.password,
    );
  }

  @ApiOperation({
    summary: 'Enviar un código para restablecer la contraseña',
    description:
      'Responde lo mismo exista o no una cuenta con ese correo, para no revelarlo.',
  })
  @Throttle({ default: RATE_LIMITS.emailCode })
  @HttpCode(HttpStatus.OK)
  @Post('password/forgot')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.requestPasswordReset(dto.email);
  }

  @ApiOperation({
    summary: 'Restablecer la contraseña con el código e iniciar sesión',
  })
  @Throttle({ default: RATE_LIMITS.login })
  @HttpCode(HttpStatus.OK)
  @Post('password/reset')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.email, dto.code, dto.password);
  }

  @ApiOperation({ summary: 'Actualizar tokens de autenticación' })
  @ApiBearerAuth()
  @Throttle({ default: RATE_LIMITS.refresh })
  @UseGuards(RefreshTokenGuard)
  @Post('refresh')
  refresh(@Req() req: Request & { user: RefreshTokenUser }) {
    return this.authService.refreshTokens(
      req.user.userId,
      req.user.refreshToken,
    );
  }

  @ApiOperation({ summary: 'Cerrar sesión (invalida el refresh token)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  logout(@Req() req: Request & { user: AuthenticatedUser }) {
    return this.authService.logout(req.user.userId);
  }
}
