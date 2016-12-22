# moray 1 "December 2016" Moray "Moray Client Tools"

## NAME

moray - command-line tools for Moray

## DESCRIPTION

Moray is a JSON-based key-value store.  Users can create **buckets**, each
containing any number of **objects** indexed by a primary **key**.  Additional
indexes can be specified with each bucket.  Moray servers are typically
stateless components deployed atop PostgreSQL databases, where buckets
correspond to database tables, objects correspond to rows, and database indexes
are created for each bucket index.

The `moray` npm package contains a set of command-line tools to allow users to
create, update, and delete both buckets and objects.  These tools connect to one
or more remote Moray servers over TCP and execute operations.

Working with buckets:

* `putbucket`: create or update a bucket
* `getbucket`: print detailed information about one bucket
* `listbuckets`: print detailed information about all buckets
* `delbucket`: delete a bucket and all of its contents

Working with objects:

* `putobject`: create or update an object
* `getobject`: fetch the contents of an object by primary key
* `delobject`: delete an object by primary key
* `findobjects`: fetch the contents of multiple objects using a filter
* `delmany`: delete multiple objects using a filter
* `updatemany`: update multiple objects using a filter
* `reindexobjects`: populate a newly-added index

Working with remote servers:

* `morayping`: check whether Moray is online
* `morayversion`: check the version of a Moray server
* `sql`: execute a SQL string on a Moray server
* `gettokens`: list the physical shards behind an electric-moray deployment

The tools in this package support two modes for locating the remote Moray server
on which to operate:

* Using the `-S`/`--service SERVICE_NAME` option or the `MORAY_SERVICE`
  environment variable, users specify a DNS domain to which SRV records are
  attached that describe the list of instances available.  SRV records provide
  both a name for the host (which may be an IP address or another DNS domain)
  and a port on which to connect over TCP.  This mode is preferred for
  general use because it provides information about all instances and allows the
  client to balance multiple requests across different, equivalent servers.
* Using the `-h`/`--host HOST_OR_IP` and `-p`/`--port PORT` options or the
  `MORAY_URL` environment variable, users specify a specific IP address or DNS
  domain to which traditional name records are attached and a TCP port to which
  to connect.  This is useful primarily for testing against specific server
  instances.

If the `-S`/`--service SERVICE_NAME` command-line option is specified, it is
always used directly as described above.

If the `-h`/`--host HOST_OR_IP` or `-p`/`--port PORT` options are specified,
they are used directly as described above.  If one is specified and not the
other, then the other value is filled in from the `MORAY_URL` environment
variable.  Otherwise, defaults of IP `127.0.0.1` port `2020` are used.

If none of these command-line options are specified:

- if `MORAY_SERVICE` is specified, it is used to invoke the first mode
- if `MORAY_URL` is specified, is used to invoke the second mode
- if neither is specified, the second mode is invoked with default values
  `127.0.0.1` port `2020`.

## OPTIONS

The following `COMMON_OPTIONS` options are accepted by all of these commands:

`-h, --host HOST_OR_IP`
    Specifies an IP address or DNS domain for the remote Moray server.  See
    above for details.

`-p, --port PORT`
    Specifies the TCP port for the remote Moray server.  See above for details.

`-S, --service SERVICE`
    Specifies a DNS domain to be used for SRV-based service discovery of the
    remote Moray server.  See above for details.  `SERVICE` must not be an IP
    address.

`-v, --verbose`
    Increases the verbosity of the built-in bunyan logger.  By default, the
    logger is created with bunyan level `fatal`.  Each additional use of `-v`
    increases the verbosity by one level (to `error`, `warn`, and so on).  Log
    messages are emitted to stderr.  See also the `LOG_LEVEL` environment
    variable.

## ENVIRONMENT

`LOG_LEVEL`
    Sets the node-bunyan logging level. Defaults to "fatal".

`MORAY_SERVICE`
    Used as a fallback value for `-S`/`--service` if neither of `-h`/`--host` or
    `-p`/`--port` is specified.

`MORAY_URL`
    A URL of the form `tcp://HOSTNAME_OR_IP[:PORT]` where the specified
    `HOSTNAME_OR_IP` and `PORT` will be used as fallback values for the
    `-h`/`--host` or `-p/--port` options, respectively.  This value is only used
    if `MORAY_SERVICE` is not present in the environment and at least one of the
    `-h`/`--host` or `-p`/`--port` options is not specified.

## EXIT STATUS

0
    Indicates successful completion

1
    Indicates failure

2
    Indicates an invalid invocation (usage error)


## EXAMPLES

<!-- XXX -->

## SEE ALSO

<!-- XXX -->

## DIAGNOSTICS

See the `-v`/`--verbose` option and the `LOG_LEVEL` environment variable.
