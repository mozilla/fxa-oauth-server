-- Drop foreign key constraints.  They make DB migrations harder
-- and aren't really providing us much value in practice.
--
-- There's a little bit of subtley here with indexes.
--
-- The `codes`, `tokens`, and `refreshTokens` tables all have explicit
-- indexes for scanning by clientId, which is good and means we don't
-- have to do anything special here.
--
-- The `clientDevelopers` table needs indexes for scanning by `developerId`
-- and by `clientId`, and prior to this patch is was using the implicit index
-- that MySQL automatically creates to enforce foreign key constraints.
-- The docs at [1] describe this index thusly:
--
--   """
--   In the referencing table, there must be an index where the foreign key
--   columns are listed as the first columns in the same order. Such an index
--   is created on the referencing table automatically if it does not exist.
--   This index might be silently dropped later, if you create another index
--   that can be used to enforce the foreign key constraint.
--   """
--   [1] https://dev.mysql.com/doc/refman/5.7/en/create-table-foreign-keys.html
--
-- The "might" in there leaves some doubt about the exact circumstances under
-- which we can depend on this index continuing to exist, so this migration
-- explicitly creates the indexes we need.  It's a two step process:
--
--  1) Explicitly create the indexes we need.  This "might" cause the ones
--     that were created automatically for the FK constraint to be dropped.
--
--  2) Drop the FK constraints, which might leave behind the auto-created
--     indexes if they weren't dropped in (1) above.
--
-- In my testing, the auto-created indexes are indeed dropped in favour
-- of the explicit ones.  If they aren't, then at least we wind up with
-- duplicate indexes which can be cleaned up manually, which is much better
-- than winding up with no indexes at all.
-- 

ALTER TABLE clientDevelopers ADD INDEX idx_clientDevelopers_developerId(developerId),
ALGORITHM = INPLACE, LOCK = NONE;

ALTER TABLE clientDevelopers ADD INDEX idx_clientDevelopers_clientId(clientId),
ALGORITHM = INPLACE, LOCK = NONE;

ALTER TABLE clientDevelopers DROP FOREIGN KEY clientDevelopers_ibfk_1,
ALGORITHM = INPLACE, LOCK = NONE;

ALTER TABLE clientDevelopers DROP FOREIGN KEY clientDevelopers_ibfk_2,
ALGORITHM = INPLACE, LOCK = NONE;

ALTER TABLE refreshTokens DROP FOREIGN KEY refreshTokens_ibfk_1,
ALGORITHM = INPLACE, LOCK = NONE;

ALTER TABLE codes DROP FOREIGN KEY codes_ibfk_1,
ALGORITHM = INPLACE, LOCK = NONE;

ALTER TABLE tokens DROP FOREIGN KEY tokens_ibfk_1,
ALGORITHM = INPLACE, LOCK = NONE;

UPDATE dbMetadata SET value = '23' WHERE name = 'schema-patch-level';
