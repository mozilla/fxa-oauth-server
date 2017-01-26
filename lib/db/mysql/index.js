/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const path = require('path');

const buf = require('buf').hex;
const hex = require('buf').to.hex;
const mysql = require('mysql');
const MysqlPatcher = require('mysql-patcher');

const config = require('../../config');
const encrypt = require('../../encrypt');
const helpers = require('../helpers');
const P = require('../../promise');
const Scope = require('../../scope');
const unique = require('../../unique');
const patch = require('./patch');

const MAX_TTL = config.get('expiration.accessToken');

// logger is not const to support mocking in the unit tests
var logger = require('../../logging')('db.mysql');

function MysqlStore(options) {
  if (options.charset && options.charset !== 'UTF8_UNICODE_CI') {
    logger.warn('createDatabase', { charset: options.charset });
  } else {
    options.charset = 'UTF8_UNICODE_CI';
  }
  options.typeCast = function(field, next) {
    if (field.type === 'TINY' && field.length === 1) {
      return field.string() === '1';
    }
    return next();
  };
  logger.info('pool.create', { options: options });
  var pool = this._pool = mysql.createPool(options);
  pool.on('enqueue', function() {
    logger.info('pool.enqueue', {
      queueLength: pool._connectionQueue && pool._connectionQueue.length
    });
  });
}

// Apply patches up to the current patch level.
// This will also create the DB if it is missing.

function updateDbSchema(patcher) {
  logger.verbose('updateDbSchema', patcher.options);

  var d = P.defer();
  patcher.patch(function(err) {
    if (err) {
      logger.error('updateDbSchema', err);
      return d.reject(err);
    }
    d.resolve();
  });

  return d.promise;
}

// Sanity-check that we're working with a compatible patch level.

function checkDbPatchLevel(patcher) {
  logger.verbose('checkDbPatchLevel', patcher.options);

  var d = P.defer();

  patcher.readDbPatchLevel(function(err) {
    if (err) {
      return d.reject(err);
    }

    // We can run if we're at or above some patch level.  Should be
    // equal at initial deployment, and may be one or more higher
    // later on, due to database changes in preparation for the next
    // release.
    if (patcher.currentPatchLevel >= patch.level) {
      return d.resolve();
    }

    err = 'unexpected db patch level: ' + patcher.currentPatchLevel;
    return d.reject(new Error(err));
  });

  return d.promise;
}

MysqlStore.connect = function mysqlConnect(options) {
  if (options.logger) {
    logger = options.logger;
  }

  options.createDatabase = options.createSchema;
  options.dir = path.join(__dirname, 'patches');
  options.metaTable = 'dbMetadata';
  options.patchKey = 'schema-patch-level';
  options.patchLevel = patch.level;
  options.mysql = mysql;
  var patcher = new MysqlPatcher(options);

  return P.promisify(patcher.connect, patcher)().then(function() {
    if (options.createSchema) {
      return updateDbSchema(patcher);
    }
  }).then(function() {
    return checkDbPatchLevel(patcher);
  }).catch(function(error) {
    logger.error('checkDbPatchLevel', error);
    throw error;
  }).finally(function () {
    return P.promisify(patcher.end, patcher)();
  }).then(function() {
    return new MysqlStore(options);
  });
};

const QUERY_CLIENT_REGISTER =
  'INSERT INTO clients ' +
  '(id, name, imageUri, hashedSecret, hashedSecretPrevious, redirectUri,' +
  'trusted, canGrant) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?);';
const QUERY_CLIENT_DEVELOPER_INSERT =
  'INSERT INTO clientDevelopers ' +
  '(rowId, developerId, clientId) ' +
  'VALUES (?, ?, ?);';
const QUERY_CLIENT_DEVELOPER_LIST_BY_CLIENT_ID =
  'SELECT developers.email, developers.createdAt ' +
  'FROM clientDevelopers, developers ' +
  'WHERE clientDevelopers.developerId = developers.developerId ' +
  'AND clientDevelopers.clientId=?;';
const QUERY_DEVELOPER_OWNS_CLIENT =
  'SELECT clientDevelopers.rowId ' +
  'FROM clientDevelopers, developers ' +
  'WHERE developers.developerId = clientDevelopers.developerId ' +
  'AND developers.email =? AND clientDevelopers.clientId =?;';
const QUERY_DEVELOPER_INSERT =
  'INSERT INTO developers ' +
  '(developerId, email) ' +
  'VALUES (?, ?);';
const QUERY_CLIENT_GET = 'SELECT * FROM clients WHERE id=?';
const QUERY_CLIENT_LIST = 'SELECT id, name, redirectUri, imageUri, ' +
  'canGrant, trusted ' +
  'FROM clients, clientDevelopers, developers ' +
  'WHERE clients.id = clientDevelopers.clientId AND ' +
  'developers.developerId = clientDevelopers.developerId AND ' +
  'developers.email =?;';
const QUERY_CLIENT_UPDATE = 'UPDATE clients SET ' +
  'name=COALESCE(?, name), imageUri=COALESCE(?, imageUri), ' +
  'hashedSecret=COALESCE(?, hashedSecret), ' +
  'hashedSecretPrevious=COALESCE(?, hashedSecretPrevious), ' +
  'redirectUri=COALESCE(?, redirectUri), ' +
  'trusted=COALESCE(?, trusted), canGrant=COALESCE(?, canGrant) ' +
  'WHERE id=?';
const QUERY_CLIENT_DELETE = 'DELETE FROM clients WHERE id=?';
const QUERY_CODE_INSERT =
  'INSERT INTO codes (clientId, userId, email, scope, authAt, offline, code) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?)';
const QUERY_ACCESS_TOKEN_INSERT =
  'INSERT INTO tokens (clientId, userId, email, scope, type, expiresAt, ' +
  'token) VALUES (?, ?, ?, ?, ?, ?, ?)';
const QUERY_REFRESH_TOKEN_INSERT =
  'INSERT INTO refreshTokens (clientId, userId, email, scope, token) VALUES ' +
  '(?, ?, ?, ?, ?)';
const QUERY_ACCESS_TOKEN_FIND = 'SELECT * FROM tokens WHERE token=?';
const QUERY_REFRESH_TOKEN_FIND = 'SELECT * FROM refreshTokens where token=?';
const QUERY_REFRESH_TOKEN_LAST_USED_UPDATE = 'UPDATE refreshTokens SET lastUsedAt=? WHERE token=?';
const QUERY_CODE_FIND = 'SELECT * FROM codes WHERE code=?';
const QUERY_CODE_DELETE = 'DELETE FROM codes WHERE code=?';
const QUERY_ACCESS_TOKEN_DELETE = 'DELETE FROM tokens WHERE token=?';
const QUERY_REFRESH_TOKEN_DELETE = 'DELETE FROM refreshTokens WHERE token=?';
const QUERY_ACCESS_TOKEN_DELETE_USER = 'DELETE FROM tokens WHERE userId=?';
const QUERY_REFRESH_TOKEN_DELETE_USER =
  'DELETE FROM refreshTokens WHERE userId=?';
const QUERY_CODE_DELETE_USER = 'DELETE FROM codes WHERE userId=?';
const QUERY_DEVELOPER = 'SELECT * FROM developers WHERE email=?';
const QUERY_DEVELOPER_DELETE = 'DELETE FROM developers WHERE email=?';
const QUERY_PURGE_EXPIRED_TOKENS = 'DELETE FROM tokens WHERE clientId NOT IN (?) AND expiresAt < NOW() LIMIT ?;';
// Token management by uid.
// Returns the most recent token used with a client name and client id.
// Does not include clients that canGrant.
const QUERY_ACTIVE_CLIENT_TOKENS_BY_UID =
  'SELECT DISTINCT clients.name, clients.id, tokens.createdAt as createdAt,tokens.scope as scope FROM clients, tokens ' +
  'WHERE tokens.expiresAt > NOW() AND clients.canGrant = 0 AND clients.id = tokens.clientId AND tokens.userId=? ' +
  'ORDER BY createdAt DESC, clients.name ' +
  'LIMIT 10000;';
const DELETE_ACTIVE_TOKENS_BY_CLIENT_AND_UID =
  'DELETE FROM tokens WHERE clientId=? AND userId=?';

function firstRow(rows) {
  return rows[0];
}

function releaseConn(connection) {
  connection.release();
}

MysqlStore.prototype = {

  ping: function ping() {
    logger.debug('ping');
    // see bluebird.using():
    // https://github.com/petkaantonov/bluebird/blob/master/API.md#resource-management
    return P.using(this._getConnection(), function(conn) {
      return new P(function(resolve, reject) {
        conn.ping(function(err) {
          if (err) {
            logger.error('ping:', err);
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });
  },

  // createdAt is DEFAULT NOW() in the schema.sql
  registerClient: function registerClient(client) {
    var id;
    if (client.id) {
      id = buf(client.id);
    } else {
      id = unique.id();
    }
    logger.debug('registerClient', { name: client.name, id: hex(id) });
    return this._write(QUERY_CLIENT_REGISTER, [
      id,
      client.name,
      client.imageUri || '',
      buf(client.hashedSecret),
      client.hashedSecretPrevious ? buf(client.hashedSecretPrevious) : null,
      client.redirectUri,
      !!client.trusted,
      !!client.canGrant
    ]).then(function() {
      logger.debug('registerClient.success', { id: hex(id) });
      client.id = id;
      return client;
    });
  },
  registerClientDeveloper: function regClientDeveloper(developerId, clientId) {
    if (!developerId || !clientId) {
      var err = new Error('Owner registration requires user and developer id');
      return P.reject(err);
    }

    var rowId = unique.id();

    logger.debug('registerClientDeveloper', {
      rowId: rowId,
      developerId: developerId,
      clientId: clientId
    });

    return this._write(QUERY_CLIENT_DEVELOPER_INSERT, [
      buf(rowId),
      buf(developerId),
      buf(clientId)
    ]);
  },
  getClientDevelopers: function getClientDevelopers (clientId) {
    if (! clientId) {
      return P.reject(new Error('Client id is required'));
    }
    return this._read(QUERY_CLIENT_DEVELOPER_LIST_BY_CLIENT_ID, [
      buf(clientId)
    ]);
  },
  activateDeveloper: function activateDeveloper(email) {
    if (! email) {
      return P.reject(new Error('Email is required'));
    }

    var developerId = unique.developerId();
    logger.debug('activateDeveloper', { developerId: developerId });
    return this._write(QUERY_DEVELOPER_INSERT, [
      developerId, email
    ]).then(function () {
      return this.getDeveloper(email);
    }.bind(this));
  },
  getDeveloper: function(email) {
    if (! email) {
      return P.reject(new Error('Email is required'));
    }

    return this._readOne(QUERY_DEVELOPER, [
      email
    ]);
  },
  removeDeveloper: function(email) {
    if (! email) {
      return P.reject(new Error('Email is required'));
    }

    return this._write(QUERY_DEVELOPER_DELETE, [
      email
    ]);
  },
  developerOwnsClient: function devOwnsClient(developerEmail, clientId) {
    return this._readOne(QUERY_DEVELOPER_OWNS_CLIENT, [
      developerEmail, buf(clientId)
    ]).then(function(result) {
      if (result) {
        return P.resolve(true);
      } else {
        return P.reject(false);
      }
    });
  },
  updateClient: function updateClient(client) {
    if (!client.id) {
      return P.reject(new Error('Update client needs an id'));
    }
    var secret = client.hashedSecret;
    if (secret) {
      secret = buf(secret);
    }

    var secretPrevious = client.hashedSecretPrevious;
    if (secretPrevious) {
      secretPrevious = buf(secretPrevious);
    }
    return this._write(QUERY_CLIENT_UPDATE, [
      // VALUES
      client.name,
      client.imageUri,
      secret,
      secretPrevious,
      client.redirectUri,
      client.trusted,
      client.canGrant,

      // WHERE
      buf(client.id)
    ]);
  },

  getClient: function getClient(id) {
    return this._readOne(QUERY_CLIENT_GET, [buf(id)]);
  },
  getClients: function getClients(email) {
    return this._read(QUERY_CLIENT_LIST, [ email ]);
  },
  removeClient: function removeClient(id) {
    return this._write(QUERY_CLIENT_DELETE, [buf(id)]);
  },
  generateCode: function generateCode(codeObj) {
    var code = unique.code();
    var hash = encrypt.hash(code);
    return this._write(QUERY_CODE_INSERT, [
      codeObj.clientId,
      codeObj.userId,
      codeObj.email,
      codeObj.scope.join(' '),
      codeObj.authAt,
      !!codeObj.offline,
      hash
    ]).then(function() {
      return code;
    });
  },
  getCode: function getCode(code) {
    var hash = encrypt.hash(code);
    return this._readOne(QUERY_CODE_FIND, [hash]).then(function(code) {
      if (code) {
        code.scope = code.scope.split(' ');
      }
      return code;
    });
  },
  removeCode: function removeCode(code) {
    var hash = encrypt.hash(code);
    return this._write(QUERY_CODE_DELETE, [hash]);
  },
  generateAccessToken: function generateAccessToken(vals) {
    var t = {
      clientId: buf(vals.clientId),
      userId: buf(vals.userId),
      email: vals.email,
      scope: Scope(vals.scope),
      token: unique.token(),
      type: 'bearer',
      expiresAt: vals.expiresAt || new Date(Date.now() + (vals.ttl  * 1000 || MAX_TTL))
    };
    return this._write(QUERY_ACCESS_TOKEN_INSERT, [
      t.clientId,
      t.userId,
      t.email,
      t.scope.toString(),
      t.type,
      t.expiresAt,
      encrypt.hash(t.token)
    ]).then(function() {
      return t;
    });
  },

  /**
   * Get an access token by token id
   * @param id Token Id
   * @returns {*}
   */
  getAccessToken: function getAccessToken(id) {
    return this._readOne(QUERY_ACCESS_TOKEN_FIND, [buf(id)]).then(function(t) {
      if (t) {
        t.scope = t.scope.split(' ');
      }
      return t;
    });
  },

  /**
   * Remove token by token id
   * @param id
   * @returns {*}
   */
  removeAccessToken: function removeAccessToken(id) {
    return this._write(QUERY_ACCESS_TOKEN_DELETE, [buf(id)]);
  },

  /**
   * Get all services that have have non-expired tokens
   * @param {String} uid User ID as hex
   * @returns {Promise}
   */
  getActiveClientTokensByUid: function getActiveClientTokensByUid(uid) {
    return this._read(QUERY_ACTIVE_CLIENT_TOKENS_BY_UID, [
      buf(uid)
    ]).then(function(activeClientIds) {
      return helpers.getActiveClientTokens(activeClientIds);
    });
  },

  /**
   * Delete all tokens for some clientId and uid.
   *
   * @param {String} clientId Client ID
   * @param {String} uid User Id as Hex
   * @returns {Promise}
   */
  deleteActiveClientTokens: function deleteActiveClientTokens(clientId, uid) {
    return this._write(DELETE_ACTIVE_TOKENS_BY_CLIENT_AND_UID, [
      buf(clientId),
      buf(uid)
    ]);
  },

  generateRefreshToken: function generateRefreshToken(vals) {
    var t = {
      clientId: vals.clientId,
      userId: vals.userId,
      email: vals.email,
      scope: Scope(vals.scope)
    };
    var token = unique.token();
    var hash = encrypt.hash(token);
    return this._write(QUERY_REFRESH_TOKEN_INSERT, [
      t.clientId,
      t.userId,
      t.email,
      t.scope.toString(),
      hash
    ]).then(function() {
      t.token = token;
      return t;
    });
  },

  getRefreshToken: function getRefreshToken(token) {
    return this._readOne(QUERY_REFRESH_TOKEN_FIND, [buf(token)])
    .then(function(t) {
      if (t) {
        t.scope = t.scope.split(' ');
      }
      return t;
    });
  },

  usedRefreshToken: function usedRefreshToken(token) {
    var now = new Date();
    return this._write(QUERY_REFRESH_TOKEN_LAST_USED_UPDATE, [
      now,
      // WHERE
      token
    ]);
  },

  removeRefreshToken: function removeRefreshToken(id) {
    return this._write(QUERY_REFRESH_TOKEN_DELETE, [buf(id)]);
  },

  getEncodingInfo: function getEncodingInfo() {
    var info = {};

    var self = this;
    var qry = 'SHOW VARIABLES LIKE "%character\\_set\\_%"';
    return this._read(qry).then(function(rows) {
      rows.forEach(function(row) {
        info[row.Variable_name] = row.Value;
      });

      qry = 'SHOW VARIABLES LIKE "%collation\\_%"';
      return self._read(qry).then(function(rows) {
        rows.forEach(function(row) {
          info[row.Variable_name] = row.Value;
        });
        return info;
      });
    });
  },

  purgeExpiredTokens: function purgeExpiredTokens(numberOfTokens, delaySeconds, ignoreClientId){
    var self = this;
    if (! ignoreClientId) {
      throw new Error('empty ignoreClientId');
    }

    if (! Array.isArray(ignoreClientId)) {
      ignoreClientId = [ ignoreClientId ];
    }

    var clientIds = ignoreClientId.map(function (id) {
      return self.getClient(id);
    });

    return P.all(clientIds)
      .then(function (results) {
        // This ensures that purgeExpiredTokens can not be called with an
        // unknown ignoreClientId(s).
        results.forEach(function (ignoreClient) {
          if (! ignoreClient) {
            throw new Error('unknown ignoreClientId ' + ignoreClientId);
          }
        });
      })
      .then(function () {
        var deleteBatchSize = 200;
        if (numberOfTokens <= deleteBatchSize) {
          deleteBatchSize = numberOfTokens;
        }

        var message = '';
        var deletedItems = 0;
        var promiseWhile = P.method(function () {
          if (deletedItems >= numberOfTokens) {
            message = 'deletedItems >= numberOfTokens';
            logger.info('purgeExpiredTokens', {
              message: message,
              deletedItems: deletedItems,
              numberOfTokens: numberOfTokens,
              deleteBatchSize: deleteBatchSize
            });
            return;
          }

          var clientIn = ignoreClientId.map(function(id) {
            return buf(id);
          });

          return self._write(QUERY_PURGE_EXPIRED_TOKENS, [clientIn, deleteBatchSize])
            .then(function (res) {
              logger.info('purgeExpiredTokens', { affectedRows: res.affectedRows });

              // Break loop if no items were effected by delete.
              // All expired tokens have been deleted.
              if (res.affectedRows === 0) {
                message = '0 affectedRows. Bailing out.';
                logger.info('purgeExpiredTokens', { message: message });
                return;
              }

              deletedItems = deletedItems + res.affectedRows;

              return P.delay(delaySeconds * 1000)
                .then(function () {
                  return promiseWhile();
                });
            });
        });

        return promiseWhile();
      })
      .then(function() {
        logger.info('purgeExpiredTokens', { message: 'completed' });
      });
  },

  removeUser: function removeUser(userId) {
    // TODO this should be a transaction or stored procedure
    var id = buf(userId);
    return this._write(QUERY_ACCESS_TOKEN_DELETE_USER, [id])
      .then(this._write.bind(this, QUERY_REFRESH_TOKEN_DELETE_USER, [id]))
      .then(this._write.bind(this, QUERY_CODE_DELETE_USER, [id]));
  },

  _write: function _write(sql, params) {
    return this._query(this._pool, sql, params);
  },

  _read: function _read(sql, params) {
    return this._query(this._pool, sql, params);
  },

  _readOne: function _readOne(sql, params) {
    return this._read(sql, params).then(firstRow);
  },

  _getConnection: function _getConnection() {
    // see bluebird.using()/disposer():
    // https://github.com/petkaantonov/bluebird/blob/master/API.md#resource-management
    //
    // tl;dr: using() and disposer() ensures that the dispose method will
    // ALWAYS be called at the end of the promise stack, regardless of
    // various errors thrown. So this should ALWAYS release the connection.
    var pool = this._pool;
    return new P(function(resolve, reject) {
      pool.getConnection(function(err, conn) {
        if (err) {
          reject(err);
        } else {
          resolve(conn);
        }
      });
    }).disposer(releaseConn);
  },

  _query: function _query(connection, sql, params) {
    return new P(function(resolve, reject) {
      connection.query(sql, params || [], function(err, results) {
        if (err) {
          reject(err);
        } else {
          resolve(results);
        }
      });
    });
  }
};

module.exports = MysqlStore;
