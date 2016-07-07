'use strict';

const Async = require('async');
const Verification = require('storj').Verification;
const storj = require('storj');
const logger = require('../logger');
const Config = require('../config');
const Storage = require('../storage');
const MongoAdapter = require('../storage/adapter');

const storageConfig = Config(process.env.NODE_ENV || 'devel').storage;
const storageAdapter = Storage(storageConfig);
const mongoAdapter = new MongoAdapter(storageAdapter);
const manager = new storj.Manager(mongoAdapter);

const AuditQueue = require('./queue.js');
const AuditDispatcher = require('./dispatcher.js');

/**
 * Audit Dispatch Service
 * @constructor
 * @param {Object} options - Dispatch service options
 * @param {Object} options.limit - ceiling of simultaneous outgoing requests
 */
const AuditQueueWorker = function(options) {
  var self = this;
  this._options = options;
  this._queue = new AuditQueue(this._options.redis, this._options.uuid);

  storageAdapter.models.Contact.recall(3, function(err, seeds) {
    if (err) {
      logger.error(err);
      process.exit();
    }
    self._connection = storj.RenterInterface({
      keypair: storj.KeyPair(self._options.network.privkey),
      manager: manager,
      logger: logger,
      seeds: seeds.map(function(seed) {
        return seed.toString();
      }),
      bridge: false,
      address: self._options.network.address,
      port: self._options.network.port,
      tunnels: self._options.network.tunnels,
      noforward: true,
      tunport: self._options.network.tunport,
      gateways: self._options.network.gateways
    });
  });

  this._dispatcher = new AuditDispatcher(this._queue, this._connection);
  this._flushStalePendingQueue(this._initDispatchQueue);
};

AuditQueueWorker.prototype._flushStalePendingQueue = function(callback) {
  var pendingQueue = Async.queue(proccessPendingQueue, this._options.limit);

  function proccessPendingQueue(audit, callback) {
    this._dispatcher._verify(audit, commitToFinal);
  }

  function commitToFinal(err, audit, hasPassed, callback) {
    this._dispatcher._commit(audit, hasPassed, callback);
  }

  this._queue.getPendingQueue(function(err, pendingAudits) {
    if(pendingAudits.length > 0) {
      pendingQueue.push(pendingAudits, function(err) {
        console.log(err);
      });
    }
  });

  pendingQueue.drain = callback;
};

AuditQueueWorker.prototype._initDispatchQueue = function() {
  var i = 0;
  var processDispatchQueue = function(callback) {
    i--;
    this._dispatcher.dispatch(callback);
  };

  var dispatchQueue = Async.queue(processDispatchQueue, this._options.limit);

  var queueNext = function(err) {
    if(err) {
      console.log(err);
    } else if(err === null) {
      i++;
      this._dispatcher._get(function(err, audit) {
        dispatchQueue.push(audit, queueNext);
      });
    }
  }

  while(i < this._options.limit) {
    queueNext(null);
  }
};

module.exports = AuditQueueWorker;