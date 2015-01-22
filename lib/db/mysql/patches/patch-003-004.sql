-- Adds support for Client Owners for OAuth clients

CREATE TABLE IF NOT EXISTS clientOwners (
  userId BINARY(16) NOT NULL,
  clientId BINARY(8) NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB CHARACTER SET utf8 COLLATE utf8_unicode_ci;

UPDATE dbMetadata SET value = '4' WHERE name = 'schema-patch-level';