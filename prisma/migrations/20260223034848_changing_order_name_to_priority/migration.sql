/*
  Warnings:

  - You are about to drop the column `order` on the `Habit` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Habit_userId_order_idx";

-- AlterTable
ALTER TABLE "Habit" DROP COLUMN "order",
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 100;

-- CreateIndex
CREATE INDEX "Habit_userId_priority_idx" ON "Habit"("userId", "priority");
