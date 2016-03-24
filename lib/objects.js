/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * lib/objects.js: object-related client API functions.  These functions are
 * invoked by same-named methods in lib/client.js to do the bulk of the work
 * associated with making RPC requests.  The arguments and semantics of these
 * functions are documented in the Moray API.
 */

var EventEmitter = require('events').EventEmitter;

var assert = require('assert-plus');
var jsprim = require('jsprim');
var libuuid = require('libuuid');
var VError = require('verror');

var rpc = require('./rpc');


///--- API

function putObject(client, bucket, key, value, options, callback) {
    var opts, log;

    assert.object(client, 'client');
    assert.string(bucket, 'bucket');
    assert.string(key, 'key');
    assert.object(value, 'value');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    opts = makeOptions(options, value);
    log = rpc.childLogger(client, opts);
    rpc.rpcCommonBufferData({
        'client': client,
        'log': log,
        'rpcmethod': 'putObject',
        'rpcargs': [ bucket, key, value, opts ]
    }, function (err, data) {
        if (!err && data.length > 1) {
            err = new VError('expected at most 1 data message, found %d',
                data.length);
        }

        if (err) {
            callback(err);
        } else {
            callback(null, data.length === 0 ? {} : data[0]);
        }
    });
}

function getObject(client, bucket, key, options, callback) {
    var opts, log;

    assert.object(client, 'client');
    assert.string(bucket, 'bucket');
    assert.string(key, 'key');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    opts = makeOptions(options);
    log = rpc.childLogger(client, opts);
    rpc.rpcCommonBufferData({
        'client': client,
        'log': log,
        'rpcmethod': 'getObject',
        'rpcargs': [ bucket, key, opts ]
    }, function (err, data) {
        if (!err && data.length != 1) {
            err = new VError('expected exactly 1 data message, found %d',
                data.length);
        }

        if (err) {
            callback(err);
        } else {
            callback(null, data[0]);
        }
    });
}

function deleteObject(client, bucket, key, options, callback) {
    var opts, log;

    assert.object(client, 'client');
    assert.string(bucket, 'bucket');
    assert.string(key, 'key');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    opts = makeOptions(options);
    log = rpc.childLogger(client, opts);
    rpc.rpcCommonBufferData({
        'client': client,
        'log': log,
        'rpcmethod': 'delObject',
        'rpcargs': [ bucket, key, opts ]
    }, function (err, data) {
        /*
         * The server provides data in a response, but historically this client
         * ignores it.
         */
        callback(err);
    });
}

function findObjects(client, bucket, filter, options) {
    var opts, log, req, res;

    assert.object(client, 'client');
    assert.string(bucket, 'bucket');
    assert.string(filter, 'filter');
    assert.object(options, 'options');

    opts = makeOptions(options);
    log = rpc.childLogger(client, opts);
    res = new EventEmitter();
    req = rpc.rpcCommon({
        'client': client,
        'log': log,
        'rpcmethod': 'findObjects',
        'rpcargs': [ bucket, filter, opts ]
    }, function (err) {
        if (err) {
            res.emit('error', err);
        } else {
            res.emit('end');
        }
    });

    req.on('data', function onObject(msg) {
        log.debug({ object: msg }, 'findObjects: record found');
        res.emit('record', msg);
    });

    return (res);
}

function batch(client, requests, options, callback) {
    assert.object(client, 'client');
    assert.arrayOfObject(requests, 'requests');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    for (var i = 0; i < requests.length; i++) {
        var r = requests[i];
        var _s = 'requests[' + i + ']';
        assert.string(r.bucket, _s + '.bucket');
        assert.optionalObject(r.options, _s + '.options');
        assert.optionalString(r.operation, _s + '.operation');
        if (r.operation === 'update') {
            assert.object(r.fields, _s + '.fields');
            assert.string(r.filter, _s + '.filter');
        } else if (r.operation === 'delete') {
            assert.string(r.key, _s + '.key');
        } else if (r.operation === 'deleteMany') {
            assert.string(r.filter, _s + '.filter');
        } else {
            r.operation = r.operation || 'put';
            assert.equal(r.operation, 'put');
            assert.string(r.key, _s + '.key');
            assert.object(r.value, _s + '.value');

            // Allowing differences between the 'value' and '_value' fields is
            // a recipe for disaster.  Any bucket with pre-update actions will
            // wipe out '_value' with a freshly stringified version.  If
            // '_value' contains an invalid JSON string, older version of moray
            // will still accept it, leading to errors when JSON parsing is
            // attempted later during get/find actions.
            // Once it can be ensured that all accessed morays are of an
            // appropriately recent version, this should be removed.
            assert.optionalString(r._value, _s + '._value');
            if (!r._value)
                r._value = JSON.stringify(r.value);

            r = (r.options || {}).headers;
            assert.optionalObject(r, _s + '.options.headers');
        }
    }

    var opts, log;

    opts = makeOptions(options);
    log = rpc.childLogger(client, opts);
    rpc.rpcCommonBufferData({
        'client': client,
        'log': log,
        'rpcmethod': 'batch',
        'rpcargs': [ requests, opts ]
    }, function (err, data) {
        if (!err && data.length > 1) {
            err = new VError('expected at most 1 data message, found %d',
                data.length);
        }

        if (err) {
            callback(err);
        } else {
            callback(null, data.length === 0 ? {} : data[0]);
        }
    });
}

function updateObjects(client, bucket, fields, filter, options, callback) {
    var opts, log;

    assert.object(client, 'client');
    assert.string(bucket, 'bucket');
    assert.object(fields, 'fields');
    assert.string(filter, 'filter');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    opts = makeOptions(options);
    log = rpc.childLogger(client, opts);
    rpc.rpcCommonBufferData({
        'client': client,
        'log': log,
        'rpcmethod': 'updateObjects',
        'rpcargs': [ bucket, fields, filter, opts ]
    }, function (err, data) {
        if (!err && data.length > 1) {
            err = new VError('expected at most 1 data message, found %d',
                data.length);
        }

        if (err) {
            callback(err);
        } else {
            callback(null, data.length === 0 ? {} : data[0]);
        }
    });
}

function deleteMany(client, bucket, filter, options, callback) {
    var opts, log;

    assert.object(client, 'client');
    assert.string(bucket, 'bucket');
    assert.string(filter, 'filter');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    opts = makeOptions(options);
    log = rpc.childLogger(client, opts);
    rpc.rpcCommonBufferData({
        'client': client,
        'log': log,
        'rpcmethod': 'deleteMany',
        'rpcargs': [ bucket, filter, opts ]
    }, function (err, data) {
        if (!err && data.length > 1) {
            err = new VError('expected at most 1 data message, found %d',
                data.length);
        }

        if (err) {
            callback(err);
        } else {
            callback(null, data.length === 0 ? {} : data[0]);
        }
    });
}

function reindexObjects(client, bucket, count, options, callback) {
    var opts, log;

    assert.object(client, 'client');
    assert.string(bucket, 'bucket');
    assert.number(count, 'count');
    assert.ok(count > 0, 'count > 0');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    opts = makeOptions(options);
    log = rpc.childLogger(client, opts);
    rpc.rpcCommonBufferData({
        'client': client,
        'log': log,
        'rpcmethod': 'reindexObjects',
        'rpcargs': [ bucket, count, opts ]
    }, function (err, data) {
        if (!err && data.length != 1) {
            err = new VError('expected exactly 1 data message, found %d',
                data.length);
        }

        if (err) {
            callback(err);
        } else {
            var result = data[0];
            log.debug({ 'processed': result.processed },
                'reindexObjects: processed');
            callback(null, result);
        }
    });
}


///--- Helpers

function makeOptions(options, value) {
    var opts = jsprim.deepCopy(options);

    // Defaults handlers
    opts.req_id = options.req_id || libuuid.create();
    opts.etag = (options.etag !== undefined) ? options.etag : options._etag;
    opts.headers = options.headers || {};
    opts.no_count = options.no_count || false;
    opts.sql_only = options.sql_only || false;
    opts.noCache = true;

    // Including the stringified value is redundant, but older versions of
    // moray depend upon the _value field being populated in this way.
    if (value)
        opts._value = JSON.stringify(value);

    if (typeof (options.noCache) !== 'undefined')
        opts.noCache = options.noCache;

    return (opts);
}


///--- Exports

module.exports = {
    putObject: putObject,
    getObject: getObject,
    deleteObject: deleteObject,
    findObjects: findObjects,
    batch: batch,
    updateObjects: updateObjects,
    deleteMany: deleteMany,
    reindexObjects: reindexObjects
};
