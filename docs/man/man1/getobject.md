# getobject 1 "December 2016" Moray "Moray Client Tools"

## NAME

getobject - fetch the contents of an object by primary key

## SYNOPSIS

`getobject [COMMON_OPTIONS] [-Hs] BUCKET KEY`

## DESCRIPTION

Fetches the contents of the object in `BUCKET` having primary key `KEY`.  The
result is emitted as JSON with properties:

`bucket`
  matches BUCKET

`key`
  matches KEY

`value`
  the contents of the object, which are completely user-defined

`_id`
  a unique, integer id associated with each object.  It should not be assumed
  that these ids are assigned in any particular order, but each update of an
  object will cause it to have a new id.  Critically, it is not true that if a
  caller inserts objects 1 and 2 concurrently and another caller sees object
  2, then it could also see object 1.  Ids may be assigned out of insertion
  order.

`_etag`
  a numeric value calculated from the contents of the object.  This can be
  used for conditional put operations.  See `putobject(1)`.

<!-- XXX -->

## OPTIONS

`-H`
  Print the object using minimal JSON (instead of inserting newlines and
  indenting for readability)

`-s`
  Accepted for backwards compatibility only.

See `moray(1)` for information about the `COMMON_OPTIONS`, which control
the log verbosity and how to locate the remote server.

## ENVIRONMENT

See `moray(1)` for information about the `LOG_LEVEL`, `MORAY_SERVICE`, and
`MORAY_URL` environment variables.

## EXAMPLES

<!-- XXX -->

## SEE ALSO

`moray(1)`, `putbucket(1)`, `putobject(1)`, `findobjects(1)`
