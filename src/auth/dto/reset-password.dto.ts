import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MinLength } from 'class-validator';
import { toNormalizedEmail } from '../email';

export class ResetPasswordDto {
  @ApiProperty({
    example: 'usuario@correo.com',
    description: 'Correo de la cuenta',
  })
  @Transform(toNormalizedEmail)
  @IsEmail()
  email: string;

  @ApiProperty({ example: '123456', description: 'Código de 6 dígitos' })
  @Matches(/^\d{6}$/, { message: 'The code has 6 digits' })
  code: string;

  @ApiProperty({
    example: '123456',
    minLength: 6,
    description: 'Nueva contraseña',
  })
  @IsString()
  @MinLength(6)
  password: string;
}
