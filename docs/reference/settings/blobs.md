# Blob storage

Where the runner and the broker keep what will never change again (the runs' logs, their
screenshots) instead of their store: needed with Redis as the store, not with the file store.
The runner's and the broker's alone; `compose.yaml` passes them from `.env`. Servers, Garage
and Amazon S3: [Blob storage](../../guides/blob-storage.md).

## Settings

- **`BLOB_URL`** (runner, broker) · environment only · default: none: the blobs stay in the store\
  The service's [blob storage](../../guides/blob-storage.md), for the blobs that will never change again: `s3://<bucket>[/<prefix>]?endpoint=https://…&region=…` or `file:///<folder>`; checked at start, a setting that fails stops the service.
- **`BLOB_ACCESS_KEY_ID`, `BLOB_SECRET_ACCESS_KEY`** (runner, broker) · environment only · default: none\
  The S3 key pair of `BLOB_URL`, never in the URL; `BLOB_ACCESS_KEY_ID_FILE` and `BLOB_SECRET_ACCESS_KEY_FILE` name files holding them instead (a Kubernetes Secret's).
