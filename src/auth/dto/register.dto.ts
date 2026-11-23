import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { toNormalizedEmail } from '../email';

export class RegisterDto {
  @ApiProperty({
    example: 'Moises Betancourt',
    maxLength: 120,
    description: 'Nombre completo del usuario',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({
    example: 'usuario@correo.com',
    description: 'Correo electronico del usuario',
  })
  @Transform(toNormalizedEmail)
  @IsEmail()
  email: string;

  @ApiProperty({
    example: '123456',
    minLength: 6,
    description: 'Contrasena del usuario',
  })
  @IsString()
  @MinLength(6)
  password: string;
}
