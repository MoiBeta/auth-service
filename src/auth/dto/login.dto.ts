import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString } from 'class-validator';
import { toNormalizedEmail } from '../email';

export class LoginDto {
  @ApiProperty({
    example: 'usuario@correo.com',
    description: 'Correo electronico registrado',
  })
  @Transform(toNormalizedEmail)
  @IsEmail()
  email: string;

  @ApiProperty({
    example: '123456',
    description: 'Contrasena del usuario',
  })
  @IsString()
  password: string;
}
