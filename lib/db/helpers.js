/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* This module consists of helpers that are used by both memory and MySQL database engines.
It gives the union of scopes and the latest token for each client. */

const unbuf = require('buf').unbuf.hex;

module.exports = {

  getActiveClientTokens: function getActiveTokens(activeClientIds) {
    var activeClients = {};
    // unique clients
    activeClientIds.forEach(function (clientTokenObj) {
      var clientIdHex = unbuf(clientTokenObj.id);
      var scope = String(clientTokenObj.scope).split(/[\s,]+/);
      if (! activeClients[clientIdHex]) {
        activeClients[clientIdHex] = clientTokenObj;
        activeClients[clientIdHex].scope = [];
      }
      scope.forEach(function (clientScope) {
        if (activeClients[clientIdHex].scope.indexOf(clientScope) === -1) {
          activeClients[clientIdHex].scope.push(clientScope);
        }
      });

      var clientTokenTime = clientTokenObj.createdAt;
      if (clientTokenTime > activeClients[clientIdHex].createdAt) {
        activeClients[clientIdHex].createdAt = clientTokenTime;
      }
    });
    var activeClientsArray = Object.keys(activeClients).map(function (key) {
      var scopes = activeClients[key].scope;
      scopes.sort(function(a, b) {
        if (b < a) {
          return 1;
        }

        if (b > a) {
          return -1;
        }

        return 0;
      });
      activeClients[key].scope = scopes;
      return activeClients[key];
    });

    var customSort = activeClientsArray.slice(0);
    customSort.sort(function(a, b) {
      if (b.createdAt > a.createdAt) {
        return 1;
      }

      if (b.createdAt < a.createdAt) {
        return -1;
      }

      if (a.name > b.name) {
        return 1;
      }

      if (a.name < b.name) {
        return -1;
      }

      return 0;
    });

    return customSort;

  }

};
