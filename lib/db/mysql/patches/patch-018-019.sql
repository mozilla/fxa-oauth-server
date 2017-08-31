CREATE TABLE applicationScopes (
  applicationScope VARCHAR(255) NOT NULL PRIMARY KEY,
  salt BINARY(32) NOT NULL,
  description VARCHAR(255) NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

ALTER TABLE clients ADD COLUMN applicationScope VARCHAR(255);

UPDATE dbMetadata SET value = '19' WHERE name = 'schema-patch-level';
