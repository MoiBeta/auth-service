export interface AuthenticatedUser {
  userId: string;
  email: string;
  /** Absent in tokens issued before it was added. */
  credentialsVersion?: number;
}
