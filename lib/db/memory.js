/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const buf = require('buf').hex;
const unbuf = require('buf').unbuf.hex;

const config = require('../config');
const encrypt = require('../encrypt');
const helpers = require('./helpers');
const logger = require('../logging')('db.memory');
const P = require('../promise');
const unique = require('../unique');

const MAX_TTL = config.get('expiration.accessToken');

/*
 * MemoryStore structure:
 * MemoryStore = {
 *   clients: {
 *     <id>: {
 *       id: <id>,
 *       hashedSecret: <string>,
 *       hashedSecretPrevious: <string>,
 *       name: <string>,
 *       imageUri: <string>,
 *       redirectUri: <string>,
 *       trusted: <boolean>,
 *       createdAt: <timestamp>
 *     }
 *   },
 *   codes: {
 *     <code>: {
 *       clientId: <client_id>,
 *       userId: <user_id>,
 *       code: <string>
 *       scope: <string>,
 *       authAt: <timestamp>,
 *       createdAt: <timestamp>,
 *       offline: <boolean>
 *     }
 *   },
 *   developers: {
 *     <developerId>: {
 *       developerId: <developer_id>,
 *       email: <string>,
 *       createdAt: <timestamp>
 *     }
 *   },
 *   clientDevelopers: {
 *     <id>: {
 *       developerId: <developer_id>,
 *       clientId: <client_id>,
 *       createdAt: <timestamp>
 *     }
 *   },
 *   tokens: {
 *     <token>: {
 *       token: <string>,
 *       clientId: <client_id>,
 *       userId: <user_id>,
 *       type: <string>,
 *       scope: <string>,
 *       createdAt: <timestamp>,
 *       expiresAt: <timestamp>
 *     }
 *   },
 *   refreshTokens: {
 *     <token>: {
 *       token: <string>,
 *       clientId: <client_id>,
 *       userId: <user_id>,
 *       scope: <string>,
 *       createdAt: <timestamp>,
 *       lastUsedAt: <timestamp>
 *     }
 *   }
 * }
 */
function MemoryStore() {
  if (!(this instanceof MemoryStore)) {
    return new MemoryStore();
  }
  this.clients = {};
  this.codes = {};
  this.tokens = {};
  this.developers = {};
  this.clientDevelopers = {};
  this.refreshTokens = {};
}

MemoryStore.connect = function memoryConnect() {
  return P.resolve(new MemoryStore());
};

function clone(obj) {
  if (!obj) {
    return obj;
  }
  var clone = {};
  for (var k in obj) {
    clone[k] = obj[k];
  }
  return clone;
}

function deleteByUserId(object, userId) {
  var ids = Object.keys(object);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    if (object[id].userId === userId) {
      delete object[id];
    }
  }
}

MemoryStore.prototype = {
  ping: function ping() {
    return P.resolve();
  },
  registerClient: function registerClient(client) {
    if (client.id) {
      client.id = buf(client.id);
    } else {
      client.id = unique.id();
    }
    var hex = unbuf(client.id);
    logger.debug('registerClient', { name: client.name, id: hex });
    client.createdAt = new Date();
    client.imageUri = client.imageUri || '';
    client.redirectUri = client.redirectUri || '';
    client.canGrant = !!client.canGrant;
    client.trusted = !!client.trusted;
    this.clients[hex] = client;
    client.hashedSecret = client.hashedSecret;
    client.hashedSecretPrevious = client.hashedSecretPrevious || '';
    return P.resolve(client);
  },
  updateClient: function updateClient(client) {
    if (!client.id) {
      return P.reject(new Error('Update client needs an id'));
    }
    var hex = unbuf(client.id);
    if (!this.clients[hex]) {
      return P.reject(new Error('Client does not exist'));
    }
    var old = this.clients[hex];
    for (var key in client) {
      if (key === 'id') {
        // nothing
      } else if (key === 'hashedSecret') {
        old.hashedSecret = buf(client[key]);
      } else if (key === 'hashedSecretPrevious') {
        old.hashedSecretPrevious = buf(client[key]);
      } else if (client[key] !== undefined) {
        old[key] = client[key];
      }
    }
    return P.resolve(old);
  },
  getClient: function getClient(id) {
    return P.resolve(this.clients[unbuf(id)]);
  },
  getClients: function getClients(email) {
    var self = this;

    return this.getDeveloper(email)
      .then(function (developer) {
        if (! developer) {
          return [];
        }

        var clients = [];

        Object.keys(self.clientDevelopers).forEach(function(key) {
          var entry = self.clientDevelopers[key];
          if (entry.developerId === developer.developerId) {
            clients.push(unbuf(entry.clientId));
          }
        });

        return clients.map(function(id) {
          var client = self.clients[id];

          return {
            id: client.id,
            name: client.name,
            imageUri: client.imageUri,
            redirectUri: client.redirectUri,
            canGrant: client.canGrant,
            trusted: client.trusted
          };
        }, this);
      });
  },
  removeClient: function removeClient(id) {
    delete this.clients[unbuf(id)];
    return P.resolve();
  },
  generateCode: function generateCode(codeObj) {
    codeObj = clone(codeObj);
    codeObj.createdAt = new Date();
    var code = unique.code();
    codeObj.code = encrypt.hash(code);
    this.codes[unbuf(codeObj.code)] = codeObj;
    return P.resolve(code);
  },
  getCode: function getCode(code) {
    return P.resolve(clone(this.codes[unbuf(encrypt.hash(code))]));
  },
  removeCode: function removeCode(code) {
    delete this.codes[unbuf(encrypt.hash(code))];
    return P.resolve();
  },
  generateAccessToken: function generateAccessToken(vals) {
    var token = unique.token();
    var now = new Date();
    var t = {
      clientId: vals.clientId,
      userId: vals.userId,
      email: vals.email,
      scope: vals.scope,
      type: 'bearer',
      createdAt: now,
      // ttl is in seconds
      expiresAt: new Date(+now + (vals.ttl * 1000 || MAX_TTL)),
      token: encrypt.hash(token)
    };
    var ret = clone(t);
    this.tokens[unbuf(t.token)] = t;
    ret.token = token;
    return P.resolve(ret);
  },
  getAccessToken: function getAccessToken(token) {
    return P.resolve(clone(this.tokens[unbuf(token)]));
  },
  removeAccessToken: function removeAccessToken(id) {
    delete this.tokens[unbuf(id)];
    return P.resolve();
  },

  /**
   * Get all services that have have non-expired tokens
   * @param {String} uid User ID as hex
   * @returns {Promise}
   */
  getActiveClientTokensByUid: function getActiveServicesByUid(uid) {
    var self = this;
    if (! uid) {
      return P.reject(new Error('Uid is required'));
    }

    var activeClientIds = [];
    var ids = Object.keys(this.tokens);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (this.tokens[id].userId.toString('hex') === uid) {
        var clientIdHex = unbuf(this.tokens[id].clientId);
        var client = self.clients[clientIdHex];
        if (client.canGrant === false) {
          activeClientIds.push({
            id: this.tokens[id].clientId,
            createdAt: this.tokens[id].createdAt,
            name: client.name,
            scope: String(this.tokens[id].scope)
          });
        }
      }
    }

    return P.resolve(helpers.getActiveClientTokens(activeClientIds));
  },

  /**
   * Delete all non-expired tokens for some clientId and uid.
   *
   * @param {String} clientId Client ID
   * @param {String} uid User Id as Hex
   * @returns {Promise}
   */
  deleteActiveClientTokens: function deleteActiveClientTokens(clientId, uid) {
    if (! clientId || ! uid) {
      return P.reject(new Error('clientId and uid are required'));
    }

    var ids = Object.keys(this.tokens);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (this.tokens[id].userId.toString('hex') === uid &&
        this.tokens[id].clientId.toString('hex') === clientId) {
        delete this.tokens[id];
      }
    }

    return P.resolve({});
  },
  generateRefreshToken: function generateRefreshToken(vals) {
    var token = unique.token();
    var t = {
      clientId: vals.clientId,
      userId: vals.userId,
      email: vals.email,
      scope: vals.scope,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      token: encrypt.hash(token)
    };
    var ret = clone(t);
    this.refreshTokens[unbuf(t.token)] = t;
    ret.token = token;
    return P.resolve(ret);
  },
  getRefreshToken: function getRefreshToken(token) {
    return P.resolve(clone(this.refreshTokens[unbuf(token)]));
  },
  usedRefreshToken: function usedRefreshToken(token) {
    if (!token) {
      return P.reject(new Error('Update needs a token'));
    }
    var hex = unbuf(token);
    if (!this.refreshTokens[hex]) {
      return P.reject(new Error('Token does not exist'));
    }
    var old = this.refreshTokens[hex];
    old.lastUsedAt = new Date();

    return P.resolve(old);
  },

  removeRefreshToken: function removeRefreshToken(id) {
    delete this.refreshTokens[unbuf(id)];
    return P.resolve();
  },
  getEncodingInfo: function getEncodingInfo() {
    console.warn('getEncodingInfo has no meaning with memory implementation'); // eslint-disable-line no-console
    return P.resolve({});
  },
  removeUser: function removeUser(userId) {
    deleteByUserId(this.tokens, userId);
    deleteByUserId(this.refreshTokens, userId);
    deleteByUserId(this.codes, userId);
    return P.resolve();
  },
  activateDeveloper: function activateDeveloper(email) {
    var self = this;

    if (! email) {
      return P.reject(new Error('Email is required'));
    }

    return this.getDeveloper(email)
      .then(function(result) {
        if (result) {
          return P.reject(new Error('ER_DUP_ENTRY'));
        }

        var newId = unique.developerId();
        var developer = {
          developerId: newId,
          email: email,
          createdAt: new Date()
        };

        self.developers[unbuf(newId)] = developer;
        return developer;

      });
  },
  getDeveloper: function getDeveloper(email) {
    var self = this;
    var developer = null;

    if (! email) {
      return P.reject(new Error('Email is required'));
    }

    Object.keys(self.developers).forEach(function(developerId) {
      var devEntry = self.developers[developerId];

      if (devEntry.email === email) {
        developer = devEntry;
      }
    });

    return P.resolve(developer);
  },
  removeDeveloper: function removeDeveloper(email) {
    var self = this;

    if (! email) {
      return P.reject(new Error('Email is required'));
    }

    Object.keys(self.developers).forEach(function(developerId) {
      var devEntry = self.developers[developerId];

      if (devEntry.email === email) {
        delete self.developers[developerId];
      }
    });

    return P.resolve();
  },
  developerOwnsClient: function devOwnsClient(developerEmail, clientId) {
    var self = this;
    var developerId;

    logger.debug('developerOwnsClient');
    return self.getDeveloper(developerEmail)
      .then(function (developer) {
        if (! developer) {
          return P.reject();
        }
        developerId = developer.developerId;

        return self.getClientDevelopers(clientId);
      })
      .then(function (developers) {

        function hasDeveloper(developer) {
          return unbuf(developer.developerId) === unbuf(developerId);
        }

        if (developers.some(hasDeveloper)) {
          return P.resolve(true);
        } else {
          return P.reject(false);
        }

      });
  },
  registerClientDeveloper: function regClientDeveloper(developerId, clientId) {
    var entry = {
      developerId: buf(developerId),
      clientId: buf(clientId),
      createdAt: new Date()
    };
    var uniqueHexId = unbuf(unique.id());

    logger.debug('registerClientDeveloper', entry);
    this.clientDevelopers[uniqueHexId] = entry;
    return P.resolve(entry);
  },
  getClientDevelopers: function getClientDevelopers(clientId) {
    var self = this;
    var developers = [];

    if (! clientId) {
      return P.reject(new Error('Client id is required'));
    }

    clientId = unbuf(clientId);

    Object.keys(self.clientDevelopers).forEach(function(key) {
      var entry = self.clientDevelopers[key];

      if (unbuf(entry.clientId) === clientId) {
        developers.push(self.developers[unbuf(entry.developerId)]);
      }
    });

    return P.resolve(developers);
  }

};

module.exports = MemoryStore;
