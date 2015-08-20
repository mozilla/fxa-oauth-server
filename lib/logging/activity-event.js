/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const logger = require('./')('activity');

module.exports = function activityEvent(event, uid, client_id, req) {
  // by the time this function is called, we'll always have a client_id somehow
  var info = {
    event: event,
    uid: uid,
    client_id: client_id,
  };
  // we're called from either a browser or a server, so check if we have this
  if ( req.headers['user-agent'] ) {
    info.userAgent = req.headers['user-agent'];
  }
  logger.info('activityEvent', info);
};
