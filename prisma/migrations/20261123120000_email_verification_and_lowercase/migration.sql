-- Emails are now stored lowercased. Two accounts whose emails only differ in
-- case would collide on the unique index: stop with a clear error so they can
-- be merged by hand instead of failing halfway.
DO $$
DECLARE
  duplicates TEXT;
BEGIN
  SELECT string_agg(lower_email, ', ') INTO duplicates
  FROM (
    SELECT lower("email") AS lower_email
    FROM "User"
    GROUP BY lower("email")
    HAVING count(*) > 1
  ) d;

  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'Accounts with the same email in different case: %', duplicates;
  END IF;
END $$;

UPDATE "User" SET "email" = lower("email") WHERE "email" <> lower("email");

ALTER TABLE "User" ADD CONSTRAINT "User_email_lowercase" CHECK ("email" = lower("email"));

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "credentialsVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "emailCodeHash" TEXT,
ADD COLUMN     "emailCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "emailCodeAttempts" INTEGER NOT NULL DEFAULT 0;

-- Google only signs in verified emails.
UPDATE "User" SET "emailVerified" = true WHERE "googleId" IS NOT NULL;
