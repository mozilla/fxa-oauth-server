/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const AppError = require('./error');
const logger = require('./logging')('server.auth_bearer');
const token = require('./token');
const validators = require('./validators');
const P = require('./promise');

const SCOPE_CLIENT_PROFILE = 'profile:write';

module.exports = function authBearer(req) {
  return new P(function(resolve, reject) {
    var auth = req.headers.authorization;
    logger.debug('check.auth', { header: auth });

    if (!auth || auth.indexOf('Bearer ') !== 0) {
      return reject(AppError.unauthorized('Bearer token not provided'));
    }
    var tok = auth.split(' ')[1];

    if (!validators.HEX_STRING.test(tok)) {
      return reject(AppError.unauthorized('Illegal Bearer token'));
    }

    token.verify(tok).done(function tokenFound(details) {
      if (details.scope.indexOf(SCOPE_CLIENT_PROFILE) === -1) {
        return reject(AppError.forbidden());
      }

      logger.info('success', details);
      resolve(details);
    }, function noToken(err) {
      logger.debug('error', err);
      reject(AppError.unauthorized('Bearer token invalid'));
    });
  });

};
