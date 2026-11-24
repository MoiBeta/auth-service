import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({ example: '123456', description: 'Código de 6 dígitos' })
  @Matches(/^\d{6}$/, { message: 'The code has 6 digits' })
  code: string;
}
