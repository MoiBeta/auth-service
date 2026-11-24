import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class SetPasswordDto {
  @ApiProperty({
    example: '123456',
    minLength: 6,
    description: 'Nueva contraseña',
  })
  @IsString()
  @MinLength(6)
  password: string;
}
