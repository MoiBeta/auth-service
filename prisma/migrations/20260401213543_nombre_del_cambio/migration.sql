/*
  Warnings:

  - You are about to drop the column `completed` on the `SubTask` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "SubTask" DROP COLUMN "completed";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "name" TEXT NOT NULL DEFAULT '';
