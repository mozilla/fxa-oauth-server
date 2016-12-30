#!/usr/bin/env node

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 This script starts both the public (server.js) and (internal.js) server.
 The two servers also share the same memory database.
 */

const cp = require('child_process');
const path = require('path');

process.env.NODE_ENV = 'dev';

var childServer = cp.fork(path.join(__dirname, '..', 'bin', 'server.js'));
childServer.on('exit', process.exit);

var childInternal = cp.fork(path.join(__dirname, '..', 'bin', 'internal.js'));
childInternal.on('exit', process.exit);

process.on('exit', function() {
  try {
    // if one of the child processes crashes or exits then we stop everything else.
    childServer.kill();
    childInternal.kill();
  } catch (e) {
    console.log(e); // eslint-disable-line no-console
  }
});
