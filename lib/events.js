/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const config = require('./config').getProperties();
const db = require('./db');
const env = require('./env');
const logger = require('./logging')('events');
const Sink = require('fxa-notifier-aws').Sink;
const HEX_STRING = require('./validators').HEX_STRING;

var fxaEvents;

if (! config.events.region || ! config.events.queueUrl) {
  fxaEvents = {
    start: function start() {
      if (env.isProdLike()) {
        throw new Error('config.events must be included in prod');
      } else {
        logger.warn('accountEvent.unconfigured');
      }
    }
  };
} else {
  fxaEvents = new Sink(config.events.region, config.events.queueUrl);

  function onData (message) {
    logger.verbose('data', message);
    if (message.event === 'delete') {
      var userId = message.uid.split('@')[0];
      if (! HEX_STRING.test(userId)) {
        message.del();
        return logger.warn('badDelete', { userId: userId });
      }
      db.removeUser(userId)
        .done(function () {
            logger.info('delete', { uid: userId });
            message.del();
          },
          function (err) {
            logger.error('removeUser', err);
            // The message visibility timeout (in SQS terms) will expire
            // and be reissued again.
          });
    } else if (message.event === 'reset' || message.event === 'passwordChange') {
      if (message.uid) {
        db.revokePublicTokens(message.uid);
        logger.info(message.event, { uid: userId });
        message.del();
      }
    } else {
      message.del();
    }
  }

  function onError (err) {
    logger.error('accountEvent', err);
  }

  fxaEvents.on('data', onData);
  fxaEvents.on('error', onError);
  fxaEvents.start = fxaEvents.fetch;
}


module.exports = {
  onData: onData,
  onError: onError,
  start: fxaEvents.start
};
