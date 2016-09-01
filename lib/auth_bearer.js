/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const AppError = require('./error');
const logger = require('./logging')('server.auth_bearer');
const token = require('./token');
const validators = require('./validators');

const authName = 'authBearer';
const authOAuthScope = 'clients:write';

exports.AUTH_STRATEGY = authName;
exports.AUTH_SCHEME = authName;

exports.SCOPE_CLIENT_WRITE = authOAuthScope;

function hasAuthScope(scopes) {
  if (! Array.isArray(scopes)) {
    return false;
  }

  for (var i = 0; i < scopes.length; i++) {
    if (scopes[i] === authOAuthScope) {
      return true;
    }
  }
  return false;
}

exports.strategy = function() {
  return {
    authenticate: function authBearerStrategy(req, reply) {
      var auth = req.headers.authorization;

      logger.debug(authName + '.check', { header: auth });
      if (!auth || auth.indexOf('Bearer ') !== 0) {
        return reply(AppError.unauthorized('Bearer token not provided'));
      }
      var tok = auth.split(' ')[1];

      if (!validators.HEX_STRING.test(tok)) {
        return reply(AppError.unauthorized('Illegal Bearer token'));
      }

      token.verify(tok).done(function tokenFound(details) {
        if (! hasAuthScope(details.scope)) {
          return reply(AppError.forbidden());
        }

        logger.info(authName + '.success', details);
        reply(null, {
          credentials: details
        });
      }, function noToken(err) {
        logger.debug(authName + '.error', err);
        reply(AppError.unauthorized('Bearer token invalid'));
      });
    }
  };
};
