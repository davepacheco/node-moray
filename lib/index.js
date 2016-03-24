/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var url = require('url');

var assert = require('assert-plus');

var Client = require('./client').Client;



///-- API

module.exports = {
    Client: Client,

    createClient: function createClient(uoptions) {
        var opts, k;

        assert.object(uoptions, 'uoptions');

        opts = {};
        for (k in uoptions) {
            opts[k] = uoptions[k];
        }

        if (opts.url && !opts.host) {
            var _u = url.parse(opts.url);
            opts.host = _u.hostname;
            opts.port = parseInt(opts.port || _u.port || 2020, 10);
            delete opts.url;
        }

        return (new Client(opts));
    }
};
