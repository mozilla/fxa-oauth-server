ALTER TABLE clients
ADD COLUMN scopes VARCHAR(1024) AFTER trusted,
ALGORITHM = INPLACE, LOCK = NONE;

UPDATE dbMetadata SET value = '20' WHERE name = 'schema-patch-level';
