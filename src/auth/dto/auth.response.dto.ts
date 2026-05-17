import { UserResponseDto } from './user.response.dto';

export class TokensDto {
  accessToken!: string;
  refreshToken!: string;
}

export class AuthResponseDto {
  user!: UserResponseDto;
  tokens!: TokensDto;
}
