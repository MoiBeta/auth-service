-- AlterTable
ALTER TABLE "EntrySubTask"
ADD COLUMN "sourceSubTaskId" TEXT;

-- Best-effort backfill for existing entry subtasks by matching the source
-- habit subtask with the same title. Rows that cannot be matched remain NULL.
UPDATE "EntrySubTask" AS est
SET "sourceSubTaskId" = st."id"
FROM "HabitEntry" AS he,
     "SubTask" AS st
WHERE est."entryId" = he."id"
  AND st."habitId" = he."habitId"
  AND st."title" = est."title"
  AND est."sourceSubTaskId" IS NULL;
