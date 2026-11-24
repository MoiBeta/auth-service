import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';
import { toNormalizedEmail } from '../email';

export class ForgotPasswordDto {
  @ApiProperty({
    example: 'usuario@correo.com',
    description: 'Correo de la cuenta',
  })
  @Transform(toNormalizedEmail)
  @IsEmail()
  email: string;
}
