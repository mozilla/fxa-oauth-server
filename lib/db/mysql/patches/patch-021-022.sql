ALTER TABLE tokens
ADD COLUMN associatedRefreshToken BINARY(32),
ADD CONSTRAINT FOREIGN KEY (associatedRefreshToken) REFERENCES refreshTokens(token) ON DELETE CASCADE;

UPDATE dbMetadata SET value = '22' WHERE name = 'schema-patch-level';
