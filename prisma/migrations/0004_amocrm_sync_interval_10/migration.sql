ALTER TABLE "AmoConnection"
  ALTER COLUMN "syncIntervalMinutes" SET DEFAULT 10;

UPDATE "AmoConnection"
SET "syncIntervalMinutes" = 10
WHERE "syncIntervalMinutes" IS NULL OR "syncIntervalMinutes" = 15;
