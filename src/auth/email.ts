/** Emails are compared and stored lowercased, without surrounding spaces. */
export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

/** class-transformer callback for email fields in request bodies. */
export const toNormalizedEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? normalizeEmail(value) : value;
