# reindexobjects 1 "December 2016" Moray "Moray Client Tools"

## NAME

reindexobjects - populate a newly-added index

## SYNOPSIS

`reindexobjects [COMMON_OPTIONS] BUCKET [COUNT]`

## DESCRIPTION

Reindexing is the process by which the internal representation of objects is
updated to account for indexes that were added after the object was last
written.  For example, if you add a new index to a bucket that already contains
a million objects, it's necessary to examine the raw JSON value of each object,
extract the value of the newly-indexed field, and add that value to the index.
Until this has been completed for all objects in the bucket, the index is
incomplete, and it will not be used in queries with `findobjects` and related
tools.  Because reindexing every object in the bucket can take quite a while,
the server does not do it automatically when the index is created with
`putbucket(1)`.  Instead, users that add indexes must use the `reindexobjects`
command to reindex all the objects in a bucket.

`reindexobjects` reindexes any objects in bucket `BUCKET` that have not been
reindexed since the last time an indexed field was added to the bucket (e.g.,
using `putbucket(1)`).  This operation performs as many queries as necessary,
each reindexing up to `COUNT` objects (which defaults to 100).  The command
stops either when all objects have been reindexed or when an error occurs.  This
operation can take an arbitrarily long time on arbitrarily large buckets.

Reindexing is idempotent.  For each object, this operation updates all indexes
that were created after the object was written.  If you add multiple indexed
fields, even in multiple operations, you only need to reindex each object once.

## OPTIONS

See `moray(1)` for information about the `COMMON_OPTIONS`, which control
the log verbosity and how to locate the remote server.

## ENVIRONMENT

See `moray(1)` for information about the `LOG_LEVEL`, `MORAY_SERVICE`, and
`MORAY_URL` environment variables.

## EXAMPLES

<!-- XXX include a whole sequence involving putbucket -->

## SEE ALSO

`moray(1)`, `putbucket(1)`
