ALTER TABLE codes
ADD COLUMN includeGrantedScopes BOOLEAN DEFAULT FALSE,
ALGORITHM = INPLACE, LOCK = NONE;

UPDATE dbMetadata SET value = '22' WHERE name = 'schema-patch-level';
