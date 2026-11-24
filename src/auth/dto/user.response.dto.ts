export class UserResponseDto {
  id!: string;
  email!: string;
  fullName!: string;
  role!: string;
  isEmailConfirmed!: boolean;
  /** False for accounts that only sign in with Google. */
  hasPassword!: boolean;
}
