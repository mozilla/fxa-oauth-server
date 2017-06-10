--  Add `publicClient` column to the `clients` table.

ALTER TABLE clients ADD COLUMN publicClient BOOLEAN DEFAULT FALSE NOT NULL AFTER canGrant;
UPDATE clients SET publicClient=false;
--  Add `authAt` column to the `codes` table.

ALTER TABLE codes
ADD COLUMN code_challenge_method VARCHAR(256) AFTER offline,
ADD COLUMN code_challenge VARCHAR(256) AFTER code_challenge_method;

UPDATE dbMetadata SET value = '18' WHERE name = 'schema-patch-level';
