/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * lib/buckets.js: bucket-related client API functions.  These functions are
 * invoked by same-named methods in lib/client.js to do the bulk of the work
 * associated with making RPC requests.  The arguments and semantics of these
 * functions are documented in the Moray API.
 */

var assert = require('assert-plus');
var libuuid = require('libuuid');
var jsprim = require('jsprim');
var VError = require('verror');

var utils = require('./utils');


///--- API

function createBucket(client, bucket, config, options, callback) {
    var cfg, opts, log;

    assert.object(client, 'client');
    assert.string(bucket, 'bucket');
    assert.object(config, 'config');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    cfg = serializeBucketConfig(config);
    opts = makeBucketOptions(options);
    log = utils.childLogger(client, opts);
    utils.rpcCommonNoData({
        'client': client,
        'rpcmethod': 'createBucket',
        'rpcargs': [ bucket, cfg, opts ],
        'log': log
    }, callback);
}

function getBucket(client, bucket, options, callback) {
    var opts, log;

    assert.object(client, 'client');
    assert.string(bucket, 'bucket');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    opts = makeBucketOptions(options);
    log = utils.childLogger(client, opts);
    utils.rpcCommonBufferData({
        'client': client,
        'rpcmethod': 'getBucket',
        'rpcargs': [ opts, bucket ],
        'log': log
    }, function (err, buckets) {
        if (!err && buckets.length != 1) {
            err = new VError('bad server response: expected 1 bucket, found %d',
                buckets.length);
        }

        if (err) {
            callback(err);
        } else {
            callback(null, parseBucketConfig(buckets[0]));
        }
    });
}

function listBuckets(client, options, callback) {
    var opts, log;

    assert.object(client, 'client');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    opts = makeBucketOptions(options);
    log = utils.childLogger(client, opts);
    utils.rpcCommonBufferData({
        'client': client,
        'rpcmethod': 'listBuckets',
        'rpcargs': [ opts ],
        'log': log
    }, function (err, buckets) {
        if (err) {
            callback(err);
        } else {
            callback(null, buckets.map(parseBucketConfig));
        }
    });
}

function updateBucket(client, bucket, config, options, callback) {
    var cfg, opts, log;

    assert.object(client, 'client');
    assert.string(bucket, 'bucket');
    assert.object(config, 'config');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    cfg = serializeBucketConfig(config);
    opts = makeBucketOptions(options);
    log = utils.childLogger(client, opts);
    utils.rpcCommonNoData({
        'client': client,
        'rpcmethod': 'updateBucket',
        'rpcargs': [ bucket, cfg, opts ],
        'log': log
    }, callback);
}

function deleteBucket(client, bucket, options, callback) {
    var opts, log;

    assert.object(client, 'client');
    assert.string(bucket, 'bucket');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    opts = makeBucketOptions(options);
    opts.bucket = bucket;
    log = utils.childLogger(client, opts);
    utils.rpcCommonNoData({
        'client': client,
        'rpcmethod': 'delBucket',
        'rpcargs': [ bucket, opts ],
        'log': log
    }, callback);
}

function putBucket(client, b, cfg, options, cb) {
    assert.object(client, 'client');
    assert.string(b, 'bucket');
    assert.object(cfg, 'config');
    assert.object(options, 'options');
    assert.func(cb, 'callback');

    var opts = makeBucketOptions(options);

    var _cb = utils.onceFatal(function put_callback(err) {
        // MANTA-1342: multiple racers doing putBucket
        // get this back b/c there's no way to be idempotent
        // with tables in postgres.  So we just check for that
        // error code and eat it -- this is somewhat dangerous
        // if two callers weren't doing the same putBucket, but
        // that's not really ever what we see in practice.
        if (err &&
            VError.findCauseByName(err, 'BucketConflictError') !== null) {
            cb(err);
        } else {
            cb();
        }
    });

    getBucket(client, b, opts, function (err, bucket) {
        if (err) {
            if (VError.findCauseByName(err, 'BucketNotFoundError') !== null) {
                createBucket(client, b, cfg, opts, _cb);
            } else {
                _cb(err);
            }
        } else {
            // MANTA-897 - short circuit client side if
            // versions are equivalent
            var v = bucket.options.version;
            var v2 = (cfg.options || {}).version || 0;
            if (v !== 0 && v === v2) {
                _cb();
            } else {
                updateBucket(client, b, cfg, opts, _cb);
            }
        }
    });
}


///--- Helpers

function serializeBucketConfig(config) {
    var cfg = utils.shallowClone(config);

    cfg.pre = (config.pre || []).map(function (f) {
        return (f.toString());
    });
    cfg.post = (config.post || []).map(function (f) {
        return (f.toString());
    });

    return (cfg);
}

function makeBucketOptions(options) {
    var opts = jsprim.deepCopy(options);
    opts.req_id = options.req_id || libuuid.create();
    return (opts);
}

/* XXX will a bad bucket here will crash the client? */
function parseBucketConfig(obj) {
    function parseFunctor(f) {
        var fn;
        /* jsl:ignore */
        eval('fn = ' + f);
        /* jsl:end */
        return (fn);
    }
    var res = {
        name: obj.name,
        index: JSON.parse(obj.index),
        pre: JSON.parse(obj.pre).map(parseFunctor),
        post: JSON.parse(obj.post).map(parseFunctor),
        options: JSON.parse(obj.options),
        mtime: new Date(obj.mtime)
    };
    if (obj.reindex_active) {
        res.reindex_active = JSON.parse(obj.reindex_active);
    }
    return (res);
}


///--- Exports

module.exports = {
    createBucket: createBucket,
    getBucket: getBucket,
    listBuckets: listBuckets,
    updateBucket: updateBucket,
    deleteBucket: deleteBucket,
    putBucket: putBucket
};
