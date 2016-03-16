/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var EventEmitter = require('events').EventEmitter;
var net = require('net');
var util = require('util');

var assert = require('assert-plus');
var cueball = require('cueball');
var fast = require('fast2');
var libuuid = require('libuuid');
var once = require('once');
var VError = require('verror');

var buckets = require('./buckets');
var objects = require('./objects');
var tokens = require('./tokens');
var utils = require('./utils');


///--- Globals

var sprintf = util.format;
var clone = utils.clone;


///--- Default values for function arguments

var dflClientSpareConnections = 4;
var dflClientMaxDnsConcurrency = 2;
var dflClientMaxConnections = 10;
var dflClientConnectRetries = 5;
var dflClientConnectTimeout = 2000;     /* milliseconds */
var dflClientDnsTimeout = 1000;         /* milliseconds */
var dflClientDnsDelayMin = 10;          /* milliseconds */
var dflClientDnsDelayMax = 10000;       /* milliseconds */
var dflClientDelayMin = 1000;           /* milliseconds */
var dflClientDelayMax = Infinity;       /* milliseconds */

var fastNRecentRequests = 100;


///--- Helpers

function emitUnavailable() {
    var emitter = new EventEmitter();
    process.nextTick(function () {
        emitter.emit('error', new Error('no active connections'));
    });
    return (emitter);
}

/*
 * This function constructs a set of node-cueball arguments based on legacy
 * properties accepted by the MorayClient constructor.  Those properties
 * included the following required properties:
 *
 *     host              string IP address or DNS name for remote Moray service.
 *                       If this is an IP address, then DNS is not used.
 *                       Otherwise, the string is used as a DNS name to find the
 *                       actual IP addresses, and this list of IPs is maintained
 *                       via periodic re-resolution of the DNS name.
 *
 *     port              positive integer: TCP port for remote Moray service
 *
 * and the following optional properties that, if not specified, have defaults
 * that are assumed to be reasonable:
 *
 *     connectTimeout    non-negative, integer number of milliseconds
 *                       to wait for TCP connections to be established
 *
 *     dns (object)      describes DNS behavior
 *
 *     dns.checkInterval non-negative, integer number of milliseconds
 *                       between periodic resolution of DNS names used to keep
 *                       the set of connected IPs up to date.  This is not used
 *                       by cueball any more.
 *
 *     dns.resolvers     array of string IP addresses to use for DNS resolvers
 *
 *     dns.timeout       non-negative, integer number of milliseconds to wait
 *                       for DNS query responses
 *
 *     maxConnections    non-negative, integer number of TCP connections that
 *                       may ever be opened to each IP address used.  If "host"
 *                       is an IP address, then this is the maximum number of
 *                       connections, but if "host" is a DNS name, then there
 *                       may be up to "maxConnections" per remote IP found in
 *                       DNS.
 *
 *     retry (object)    describes a retry policy used for establishing
 *                       connections.  Historically, the behavior with respect
 *                       to this policy was confusing at best: this policy was
 *                       used for establishing TCP connections to remote
 *                       servers, but a second, hardcoded policy was used when
 *                       this first policy was exhausted.  This policy appears
 *                       to have been intended to cover DNS operations as well,
 *                       but was not actually used.  In the current
 *                       implementation, this policy is the one used for TCP
 *                       connection establishment, and callers wanting to
 *                       specify a DNS policy must specify cueball options
 *                       directly rather than using these legacy options.
 *
 *     retry.retries     non-negative, integer number of retry attempts.  It's
 *                       unspecified whether this is the number of attempts or
 *                       the number of retries (i.e., one fewer than the number
 *                       of attempts).  Today, this is interpreted by
 *                       node-cueball.  Historically, this was interpreted by
 *                       the node-backoff.
 *
 *     retry.minTimeout  non-negative, integer number of milliseconds to wait
 *                       after the first operation failure before retrying
 *
 *     retry.maxTimeout  non-negative, integer representing the maximum number
 *                       of milliseconds between retries.  Some form of backoff
 *                       (likely exponential) is used to determine the delay,
 *                       but it will always be between retry.minTimeout and
 *                       retry.maxTimeout.
 *
 * Additional properties were at one time documented, but never used:
 * maxIdleTime and pingTimeout.
 */
function translateLegacyOptions(options)
{
    var cueballOptions, r;

    assert.string(options.host, 'options.host');
    assert.number(options.port, 'options.port');
    assert.optionalNumber(options.maxConnections, 'options.maxConnections');
    assert.optionalNumber(options.connectTimeout, 'options.connectTimeout');
    assert.optionalObject(options.retry, 'options.retry');
    assert.optionalObject(options.dns, 'options.dns');

    cueballOptions = {
        'domain': options.host,
        'defaultPort': options.port,
        'maximum': options.maxConnections || dflClientMaxConnections,
        'spares': dflClientSpareConnections,
        'maxDNSConcurrency': dflClientMaxDnsConcurrency,
        'recovery': {}
    };

    /*
     * DNS configuration: The delay and maxDelay values used in the previous
     * implementation were always hardcoded to the default values used here.
     */
    r = cueballOptions.recovery.dns = {
        'retries': dflClientConnectRetries,
        'timeout': dflClientDnsTimeout,
        'delay': dflClientDnsDelayMin,
        'maxDelay': dflClientDnsDelayMax
    };

    if (options.dns) {
        if (Array.isArray(options.dns.resolvers)) {
            assert.arrayOfString(options.dns.resolvers,
                'options.dns.resolvers');
            cueballOptions.resolvers = options.dns.resolvers.slice(0);
        }

        if (options.dns.timeout) {
            assert.number(options.dns.timeout, 'options.dns.timeout');
            assert.ok(options.dns.timeout >= 0,
                'dns timeout must be non-negative');
            r.timeout = options.dns.timeout;
        }
    }

    /*
     * Right or wrong, the legacy behavior was that the timeout for each
     * request never increased.
     */
    r.maxTimeout = r.timeout;

    /*
     * Default recovery configuration: we specify a 'default' recovery in
     * the cueball options that will cover both the initial connect attempt
     * and subsequent connect attempts.
     */
    r = cueballOptions.recovery.default = {};
    if (typeof (options.connectTimeout) == 'number') {
        assert.ok(options.connectTimeout >= 0,
            'connect timeout must be non-negative');
        r.timeout = options.connectTimeout;
    } else {
        r.timeout = dflClientConnectTimeout;
    }

    /*
     * As with DNS requests, connection operations historically used a fixed
     * timeout value.
     */
    r.maxTimeout = r.timeout;

    if (options.retry) {
        assert.optionalNumber(options.retry.retries, 'options.retry.retries');
        if (typeof (options.retry.retries) == 'number') {
            r.retries = options.retry.retries;
        } else {
            r.retries = dflClientConnectRetries;
        }

        /*
         * It's confusing, but the "timeout" for a retry policy is
         * really a delay.
         */
        assert.optionalNumber(options.retry.minTimeout,
            'options.retry.minTimeout');
        if (typeof (options.retry.minTimeout) == 'number') {
            r.delay = options.retry.minTimeout;

            if (typeof (options.retry.maxTimeout) == 'number') {
                assert.ok(options.retry.maxTimeout >=
                    options.retry.minTimeout,
                    'retry.maxTimeout must not be smaller ' +
                    'than retry.minTimeout');
                r.maxDelay = options.retry.maxTimeout;
            } else {
                r.delay = options.retry.minTimeout;
                r.maxDelay = Math.max(r.delay, dflClientDelayMax);
            }
        } else if (typeof (options.retry.maxTimeout) == 'number') {
            r.maxDelay = options.retry.maxTimeout;
            r.delay = Math.min(dflClientDelayMin, r.maxDelay);
        } else {
            r.delay = dflClientDelayMin;
            r.maxDelay = dflClientDelayMax;
        }

        assert.number(r.delay);
        assert.number(r.maxDelay);
        assert.ok(r.delay <= r.maxDelay);
    }

    return (cueballOptions);
}


///--- API

function ping(client, options, callback) {
    assert.object(client, 'client');
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.optionalNumber(options.timeout, 'options.timeout');
    assert.func(callback, 'callback');

    callback = once(callback);

    var opts = {
        deep: options.deep || false,
        req_id: options.req_id || libuuid.create()
    };
    var log = utils.childLogger(client, opts);
    var req;
    var t;

    log.debug(opts, 'ping: entered');

    function done(err) {
        clearTimeout(t);
        // 'error' and 'end' listeners aren't removed here since *this* function
        // is timing out the requests and the fast client can still emit events.
        // See: MANTA-1977

        log.debug({
            err: err,
            req_id: opts.req_id
        }, 'ping: %s', err ? 'failed' : 'done');

        callback(err || null);
    }
    done = once(done);

    req = client.rpc('ping', opts);
    req.once('end', done);
    req.once('error', done);
    t = setTimeout(function onTimeout() {
        done(new Error('ping: timeout'));
    }, (options.timeout || 1000));
}

function version(client, options, callback) {
    assert.object(client, 'client');
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.optionalNumber(options.timeout, 'options.timeout');
    assert.func(callback, 'callback');

    var opts = {
        deep: options.deep || false,
        req_id: options.req_id || libuuid.create()
    };
    var log = utils.childLogger(client, opts);
    var req;
    var t;

    log.debug(opts, 'version: entered');

    var done = once(function (err, data) {
        clearTimeout(t);
        // 'error' and 'end' listeners aren't removed here since *this* function
        // is timing out the requests and the fast client can still emit events.
        // See: MANTA-1977

        log.debug({
            err: err,
            req_id: opts.req_id
        }, 'ping: %s', err ? 'failed' : 'done');

        // For this specific endpoint, errors are not propagated.  Instead the
        // minimum version (1) is returned to the caller.  This is because
        // older versions of node-fast lacked a mechanism for communicating the
        // lack of an RPC binding to clients.  When communicating with such an
        // instance, this call will timeout, despite proper connectivity.
        // This call is not to be used for verifying connectivity.
        var ver = 0;
        if (typeof (data) === 'object' && data.version !== undefined) {
            ver = parseInt(data.version, 10);
        }
        if (ver <= 0) {
            ver = 1; // Minimum moray API version
        }


        callback(ver);
    });

    req = client.rpc('version', opts);
    req.on('message', function (msg) {
        if (msg !== null) {
            log.debug('version: msg: %j', msg);
            done(null, msg);
        }
    });
    req.once('error', done);
    t = setTimeout(function onTimeout() {
        done(new Error('version: timeout'));
    }, (options.timeout || 1000));
}

function sql(client, statement, values, options) {
    assert.object(client, 'client');
    assert.string(statement, 'statement');
    assert.ok(Array.isArray(values));
    assert.object(options, 'options');

    var opts = {
        req_id: options.req_id || libuuid.create()
    };
    var log = utils.childLogger(client, opts);
    var req = client.rpc('sql', statement, values, opts);
    var res = new EventEmitter();

    log.debug({
        statement: statement,
        values: values
    }, 'sql: entered');

    req.on('message', function (msg) {
        if (msg !== null) {
            log.debug('sql: msg: %j', msg);
            res.emit('record', msg);
        }
    });

    req.once('end', function () {
        log.debug('sql: done');
        res.removeAllListeners('res');
        res.removeAllListeners('error');
        res.emit('end');
    });

    req.once('error', function (err) {
        log.debug({
            err: err,
            req_id: opts.req_id
        }, 'sql: failed');
        res.removeAllListeners('data');
        res.removeAllListeners('end');
        res.emit('error', err);
    });

    return (res);
}


///--- API

/*
 * Constructor for the moray client.
 *
 * This client uses the cueball module to maintain a pool of TCP connections to
 * the IP addresses associated with a DNS name.  cueball is responsible for
 * DNS resolution (periodically, in the background), maintaining the appropriate
 * TCP connections, and balancing requests across connections.
 *
 * The following named arguments must be specified:
 *
 *     log             bunyan-style logger
 *
 * You must also specify either:
 *
 *     cueballOptions  options used in the constructor of a node-cueball
 *                     ConnectionPool.  See node-cueball documentation.  You
 *                     should not specify the "constructor" or "log" options --
 *                     only the options related to DNS configuration, recovery,
 *                     and connection management.
 *
 * or some combination of legacy options documented with
 * translateLegacyOptions() above.  It's strongly recommended that new consumers
 * use the "cueballOptions" approach because it's much less confusing and allows
 * specifying additional important parameters.
 *
 * A sample invocation:
 *
 *     var client = moray.createClient({
 *         'log': bunyan.createLogger({
 *             'name': 'MorayClient',
 *             'level': process.env.LOG_LEVEL || 'debug',
 *             'stream': process.stdout
 *         }),
 *         'cueballOptions': {
 *             'domain': 'moray.mydatacenter.joyent.us',
 *             'defaultPort': 2020,
 *             'spares': 4,
 *             'maximum': 10,
 *             'maxDNSConcurrency': 2,
 *             'recovery': {
 *                 'default': {
 *                     'retries': 10,
 *                     'timeout': 1000,
 *                     'maxTimeout': 10000,
 *                     'delay': 1000,
 *                     'maxDelay': 60000
 *                 }
 *             }
 *         }
 *     });
 */
function MorayClient(options) {
    var self = this;
    var cueballOptions;

    EventEmitter.call(this);

    assert.object(options, 'options');
    assert.object(options.log, 'options.log');

    /*
     * Many of the client options determine how we configure the cueball module.
     * For compatibility with pre-cueball clients, we accept the old options and
     * translate them into arguments for cueball.  Modern clients may specify
     * cueball options directly, in which case we demand that they have not
     * specified any of these legacy options.
     */
    if (options.hasOwnProperty('cueballOptions')) {
        assert.ok(!options.hasOwnProperty('host'));
        assert.ok(!options.hasOwnProperty('port'));
        assert.ok(!options.hasOwnProperty('connectTimeout'));
        assert.ok(!options.hasOwnProperty('dns'));
        assert.ok(!options.hasOwnProperty('maxConnections'));
        assert.ok(!options.hasOwnProperty('retry'));
        assert.string(options.cueballOptions.domain,
            'options.cueballOptions.domain');
        cueballOptions = clone(options.cueballOptions);
    } else {
        cueballOptions = translateLegacyOptions(options);
    }

    assert.string(cueballOptions.domain, 'cueballOptions.domain');
    this.hostLabel = cueballOptions.domain;
    this.log = options.log.child({
        component: 'MorayClient',
        domain: cueballOptions.domain
    }, true);

    cueballOptions.constructor = function cueballConstructor(backend) {
        return (self.makeFastClient(backend));
    };
    cueballOptions.log = this.log.child({ 'component': 'cueball' }, true);

    this.cueball = new cueball.ConnectionPool(cueballOptions);
}

util.inherits(MorayClient, EventEmitter);

/*
 * Given a cueball "backend", return a cueball-compatible connection.  The
 * We actually just return a plain TCP connection off which we've hung a
 * FastClient wrapped over the connection.  That's kind of dodgy.  We could
 * instead create a wrapper object that looks like a TCP connection
 * (implementing the same methods and emitting the same events), but which has a
 * reference to our fast client.
 */
MorayClient.prototype.makeFastClient = function makeFastClient(backend) {
    var csock;

    assert.string(backend.name, 'backend.name');
    assert.string(backend.address, 'backend.address');
    assert.number(backend.port, 'backend.port');

    csock = net.createConnection(backend.port, backend.address);
    csock._fast_client = new fast.FastClient({
        'nRecentRequests': fastNRecentRequests,
        'transport': csock,
        'log': this.log.child({
            'component': 'FastClient',
            'backendName': backend.name,
            'backendAddress': backend.address + ':' + backend.port
        })
    });

    return (csock);
};


/**
 * Shuts down all connections and closes this client down.
 */
MorayClient.prototype.close = function close() {
    this.cueball.stop();
    setImmediate(this.emit.bind(this), 'close');
};


/**
 * Creates a Bucket
 *
 * `cfg` allows you to pass in index information, as well as pre/post triggers.
 * See https://mo.joyent.com/docs/moray/master/#CreateBucket for more info.
 *
 * @param {String} b    - Bucket name
 * @param {Object} cfg  - configuration
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.createBucket = function createBucket(b, cfg, opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    var client = this.getClient(cb);
    if (client)
        buckets.createBucket(client, b, cfg, opts, cb);
};


/**
 * Fetches a Bucket
 *
 * See https://mo.joyent.com/docs/moray/master/#GetBucket for more info.
 *
 * @param {String} b    - Bucket name
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.getBucket = function getBucket(b, opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    var client = this.getClient(cb);
    if (client)
        buckets.getBucket(client, b, opts, cb);
};


/**
 * Lists all buckets
 *
 * See https://mo.joyent.com/docs/moray/master/#ListBucket for more info.
 *
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.listBuckets = function listBuckets(opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }

    var client = this.getClient(cb);

    if (client)
        buckets.listBuckets(client, opts, cb);
};


/**
 * Updates an existing Bucket
 *
 * `cfg` allows you to pass in index information, as well as pre/post triggers.
 * See https://mo.joyent.com/docs/moray/master/#UpdateBucket for more info.
 *
 * @param {String} b    - Bucket name
 * @param {Object} cfg  - configuration
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.updateBucket = function updateBucket(b, cfg, opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    var client = this.getClient(cb);
    if (client)
        buckets.updateBucket(client, b, cfg, opts, cb);
};


/**
 * Deletes a Bucket
 *
 * See https://mo.joyent.com/docs/moray/master/#DeleteBucket for more info.
 *
 * @param {String} b    - Bucket name
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.deleteBucket = function deleteBucket(b, opts, cb) {
    assert.string(b, 'bucket');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var client = this.getClient(cb);
    if (client)
        buckets.deleteBucket(client, b, opts, cb);
};
MorayClient.prototype.delBucket = MorayClient.prototype.deleteBucket;


/**
 * Creates or replaces a Bucket.
 *
 * Note that this is actually just a client shim, and simply calls
 * get, followed by create || update.  This is not transactional,
 * and there are races, so you probably just want to call this once
 * at startup in your code.
 *
 * @param {String} b    - Bucket name
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.putBucket = function putBucket(b, cfg, opts, cb) {
    assert.string(b, 'bucket');
    assert.object(cfg, 'config');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var client = this.getClient(cb);
    if (client)
        buckets.putBucket(client, b, cfg, opts, cb);
};


/**
 * Idempotently Creates or Replaces an Object.
 *
 * See https://mo.joyent.com/docs/moray/master/#PutObject for more info.
 *
 * @param {String} b    - Bucket name
 * @param {String} k    - Key name
 * @param {Object} v    - Value
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.putObject = function putObject(b, k, v, opts, cb) {
    assert.string(b, 'bucket');
    assert.string(k, 'key');
    assert.object(v, 'value');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var client = this.getClient(cb);
    if (client)
        objects.putObject(client, b, k, v, opts, cb);
};


/**
 * Fetches an Object
 *
 * See https://mo.joyent.com/docs/moray/master/#GetObject for more info.
 *
 * @param {String} b    - Bucket name
 * @param {String} k    - Key name
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.getObject = function getObject(b, k, opts, cb) {
    assert.string(b, 'bucket');
    assert.string(k, 'key');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var client = this.getClient(cb);
    if (client)
        objects.getObject(client, b, k, opts, cb);
};


/**
 * Deletes an Object
 *
 * See https://mo.joyent.com/docs/moray/master/#DeleteObject for more info.
 *
 * @param {String} b    - Bucket name
 * @param {String} k    - Key name
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.deleteObject = function deleteObject(b, k, opts, cb) {
    assert.string(b, 'bucket');
    assert.string(k, 'key');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var client = this.getClient(cb);
    if (client)
        objects.deleteObject(client, b, k, opts, cb);
};
MorayClient.prototype.delObject = MorayClient.prototype.deleteObject;


/**
 * Finds object matching a given filter
 *
 * See https://mo.joyent.com/docs/moray/master/#FindObjects for more info.
 *
 * @param {String} b      - Bucket name
 * @param {String} f      - Object filter
 * @param {Object} opts   - request parameters
 * @return {EventEmitter} - listen for 'record', 'end' and 'error'
 */
MorayClient.prototype.findObjects = function findObjects(b, f, opts) {
    assert.string(b, 'bucket');
    assert.string(f, 'filter');
    assert.optionalObject(opts, 'options');

    var client = this.getClient();
    if (client) {
        return (objects.findObjects(client, b, f, (opts || {})));
    }
    return (emitUnavailable());
};
MorayClient.prototype.find = MorayClient.prototype.findObjects;


/**
 * Idempotently Creates or Replaces a set of Object.
 *
 * See https://mo.joyent.com/docs/moray/master/#Batch for more info.
 *
 * @param {Array} requests - {bucket, key, value} tuples
 * @param {Object} opts - request parameters
 * @param {Function} cb - callback
 */
MorayClient.prototype.batch = function batch(requests, opts, cb) {
    assert.arrayOfObject(requests, 'requests');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var client = this.getClient(cb);
    if (client)
        objects.batch(client, requests, opts, cb);
};


/**
 * Updates a set of object attributes.
 *
 * See https://mo.joyent.com/docs/moray/master/#UpdateObjects for more info.
 *
 * @param {String} bucket - bucket
 * @param {Object} fields - attributes to update (must be indexes)
 * @param {String} filter - update objects matching this filter
 * @param {Object} opts   - request parameters
 * @param {Function} cb   - callback
 */
MorayClient.prototype.updateObjects = function update(b, f, f2, opts, cb) {
    assert.string(b, 'bucket');
    assert.object(f, 'fields');
    assert.string(f2, 'filter');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var client = this.getClient(cb);
    if (client)
        objects.updateObjects(client, b, f, f2, opts, cb);
};


/**
 * Deletes a group of objects.
 *
 * See https://mo.joyent.com/docs/moray/master/#DeleteMany for more info.
 *
 * @param {String} bucket - bucket
 * @param {String} filter - update objects matching this filter
 * @param {Object} opts   - request parameters
 * @param {Function} cb   - callback
 */
MorayClient.prototype.deleteMany = function deleteMany(b, f, opts, cb) {
    assert.string(b, 'bucket');
    assert.string(f, 'filter');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var client = this.getClient(cb);
    if (client)
        objects.deleteMany(client, b, f, opts, cb);
};


/**
 * Request reindexing of stale rows.
 *
 * Returns a count of successfully processed rows.  Once the processed count
 * reaches zero, all rows will be properly reindexed.
 *
 * @param {String} bucket - bucket
 * @param {String} count  - max objects to reindex
 * @param {Object} opts   - request parameters
 * @param {Function} cb   - callback
 */
MorayClient.prototype.reindexObjects = function reindexObjects(b, c, opts, cb) {
    assert.string(b, 'bucket');
    assert.number(c, 'count');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var client = this.getClient(cb);
    if (client)
        objects.reindexObjects(client, b, c, opts, cb);
};


/*
 * Gets the set of tokens from moray.
 *
 * See https://mo.joyent.com/docs/moray/master/#UpdateObjects for more info.
 *
 * @param {Object} opts   - request parameters
 * @param {Function} cb   - callback
 */
MorayClient.prototype.getTokens = function getTokens(opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var client = this.getClient(cb);
    if (client)
        tokens.getTokens(client, opts, cb);
};


/**
 * Performs a ping check against the server.
 *
 * Note that because the MorayClient is pooled and connects to all IPs in
 * a RR-DNS set, this actually just tells you that _one_ of the servers is
 * responding, not that all are.
 *
 * In most cases, you probably want to send in '{deep: true}' as options
 * so a DB-level check is performed on the server.
 *
 * @param {Object} opts   - request parameters
 * @return {EventEmitter} - listen for 'record', 'end' and 'error'
 */
MorayClient.prototype.ping = function _ping(opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var client = this.getClient(cb);
    if (client)
        ping(client, opts, cb);
};

/**
 * Query the API version of the server.
 *
 * As the Moray server develops features, it may be necessary to differentiate
 * between instance which do or do not possess updated functionality.  This
 * queries the version, if present, from the server.  If the version is not
 * present, or an error occurs, MorayClient defaults to the minimum possible
 * version of 1.
 *
 * The callback is invoked with the version as the first and  only parameter.
 *
 * @param {Object} opts   - request parameters
 * @param {Function} cb   - callback
 */
MorayClient.prototype.version = function _version(opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var client = this.getClient(cb);
    if (client)
        version(client, opts, cb);
};


/**
 * Performs a raw SQL operation against the server.
 *
 * For the love of all this good in this earth, please only use this method
 * at the utmost of need.  In almost every case this is used, it's used for
 * nefarious reasons.
 *
 * The only intended uses of this are for edge cases that require custom
 * "serial" tables, et al, in the database (like UFDS changelog).  You
 * absolutely do not ever need to use this if put/get/del/find works for you.
 *
 * @param {String} stmt   - SQL Statement
 * @param {Array} vals    - Values (if SQL statement has $1 etc. in it)
 * @param {Object} opts   - Request Options
 * @return {EventEmitter} - listen for 'record', 'end' and 'error'
 */
MorayClient.prototype.sql = function _sql(stmt, vals, opts) {
    switch (arguments.length) {
    case 0:
        throw new TypeError('statement (String) required');
    case 1:
        assert.string(stmt, 'statement');
        vals = [];
        opts = {};
        break;
    case 2:
        assert.string(stmt, 'statement');
        if (!Array.isArray(vals)) {
            assert.object(vals, 'options');
            opts = vals;
            vals = [];
        } else {
            opts = {};
        }
        break;
    case 3:
        assert.string(stmt, 'statement');
        assert.ok(Array.isArray(vals));
        assert.object(opts, 'options');
        break;
    default:
        throw new Error('too many arguments');
    }

    var client = this.getClient();
    if (client) {
        return (sql(client, stmt, vals, opts));
    }
    return (emitUnavailable());
};


MorayClient.prototype.toString = function toString() {
    var str = sprintf('[object MorayClient<host=%s>]', this.hostLabel);
    return (str);
};


/*
 * This internal helper function is invoked by all of the RPC methods (e.g.,
 * findObjects() and the like) in order to obtain a client with which to make
 * the RPC request.  There are two general patterns:
 *
 *    (1) For callback-based RPCs like getObject(), if no client is available,
 *        then an error should be emitted to the callback.  To simplify this
 *        case, this function takes an optional callback that is invoked if (and
 *        only if) no client is available.  The callback is provided a suitable
 *        Error.
 *
 *    (2) For event-emitter-based RPCs like findObjects(), if no client is
 *        available, then the RPC function's caller will get an EventEmitter
 *        that immediately emits 'error' with a suitable error.  This case is
 *        not simplified by this function.  Callers just omit the optional
 *        callback and take responsibility for emitting the error themselves.
 */
MorayClient.prototype.getClient = function getClient(callback) {
    var cb, claim, client;

    assert.optionalFunc(callback, 'callback');

    cb = once(function _cb(err) {
        if (callback) {
            callback(err);
        }
    });

    try {
        claim = this.cueball.claimSync();
    } catch (ex) {
        if (callback) {
            cb(new VError(ex, 'failed to claim connection'));
        }

        return (null);
    }

    /*
     * Cueball handed us back the connection we gave it, which is a net.Socket
     * that has our Fast client hanging off of it.  In order to release this
     * connection, we need to hold onto this other handle we just got back.
     * We'll just hang this off the Fast client.  This could all be cleaned up a
     * bit as described with makeFastClient() above.
     */
    assert.object(claim.handle);
    assert.object(claim.connection);
    assert.object(claim.connection._fast_client);
    client = claim.connection._fast_client;
    client._moray_cueball_handle = claim.handle;
    return (client);
};



///--- Exports

module.exports = {
    Client: MorayClient
};
