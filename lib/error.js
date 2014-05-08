/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const util = require('util');

const DEFAULTS = {
  code: 500,
  error: 'Internal Server Error',
  errno: 999,
  message: 'Unspecified error'
};

function AppError(options, extra, headers) {
  this.message = options.message || DEFAULTS.message;
  this.isBoom = true;
  this.stack = options.stack;
  this.errno = options.errno || DEFAULTS.errno;
  this.output = {
    statusCode: options.code || DEFAULTS.code,
    payload: {
      code: options.code || DEFAULTS.code,
      errno: this.errno,
      error: options.error || DEFAULTS.error,
      message: this.message,
      info: options.info || DEFAULTS.info
    },
    headers: headers || {}
  };
  var keys = Object.keys(extra || {});
  for (var i = 0; i < keys.length; i++) {
    this.output.payload[keys[i]] = extra[keys[i]];
  }
}
util.inherits(AppError, Error);

AppError.prototype.toString = function () {
  return 'Error: ' + this.message;
};

AppError.prototype.header = function (name, value) {
  this.output.headers[name] = value;
};

AppError.translate = function translate(response) {
  if (response instanceof AppError) {
    return response;
  }

  var error;
  var payload = response.output.payload;
  if (payload.validation) {
    error = AppError.invalidRequestParameter(payload.validation);
  } else {
    error = new AppError({
      message: payload.message,
      code: payload.statusCode,
      error: payload.error,
      errno: payload.errno,
      stack: response.stack
    });
  }

  return error;
};

AppError.unknownClient = function unknownClient(clientId) {
  return new AppError({
    code: 400,
    error: 'Bad Request',
    errno: 101,
    message: 'Unknown client'
  }, {
    clientId: clientId
  });
};

AppError.incorrectSecret = function incorrectSecret(clientId) {
  return new AppError({
    code: 400,
    error: 'Bad Request',
    errno: 102,
    message: 'Incorrect secret'
  }, {
    clientId: clientId
  });
};

AppError.incorrectRedirect = function incorrectRedirect(uri) {
  return new AppError({
    code: 400,
    error: 'Bad Request',
    errno: 103,
    message: 'Incorrect redirect_uri'
  }, {
    redirectUri: uri
  });
};

AppError.invalidAssertion = function invalidAssertion() {
  return new AppError({
    code: 400,
    error: 'Bad Request',
    errno: 104,
    message: 'Invalid assertion'
  });
};
AppError.unknownCode = function unknownCode(code) {
  return new AppError({
    code: 400,
    error: 'Bad Request',
    errno: 105,
    message: 'Unknown code'
  }, {
    requestCode: code
  });
};

AppError.mismatchCode = function mismatchCode(code, clientId) {
  return new AppError({
    code: 400,
    error: 'Bad Request',
    errno: 106,
    message: 'Incorrect code'
  }, {
    requestCode: code,
    client: clientId
  });
};

AppError.expiredCode = function mismatchCode(code, expiredAt) {
  return new AppError({
    code: 400,
    error: 'Bad Request',
    errno: 107,
    message: 'Expired code'
  }, {
    requestCode: code,
    expiredAt: expiredAt
  });
};

AppError.invalidToken = function invalidToken(token) {
  return new AppError({
    code: 400,
    error: 'Bad Request',
    errno: 108,
    message: 'Invalid token'
  }, {
    token: token
  });
};

AppError.existingKey = function existingKey(key) {
  return new AppError({
    code: 400,
    error: 'Bad Request',
    errno: 109,
    message: 'Existing pubkey'
  }, {
    key: key
  });
};

AppError.invalidRequestParameter = function invalidRequestParameter(val) {
  return new AppError({
    code: 400,
    error: 'Bad Request',
    errno: 110,
    message: 'Invalid request parameter'
  }, {
    validation: val
  });
};

module.exports = AppError;
