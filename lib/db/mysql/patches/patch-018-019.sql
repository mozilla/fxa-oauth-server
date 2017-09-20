ALTER TABLE codes ADD COLUMN keysJwe VARCHAR(1024),
ALGORITHM = INPLACE, LOCK = NONE;

UPDATE dbMetadata SET value = '19' WHERE name = 'schema-patch-level';
