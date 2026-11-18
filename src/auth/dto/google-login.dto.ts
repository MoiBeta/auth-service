import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class GoogleLoginDto {
  @ApiProperty({
    description: 'ID token returned by Google Sign-In on the device',
  })
  @IsString()
  @IsNotEmpty()
  idToken: string;
}
