-- Run against ChatCode PostgreSQL with a read-only role.
SELECT CASE WHEN object_key IS NULL THEN 'database'
            WHEN object_key LIKE 'chatcode/r2/%' THEN 'r2'
            ELSE 'legacy object storage' END AS location,
       count(*) AS attachments, sum(byte_count) AS encrypted_bytes
FROM chatcode_messages WHERE attachment_id IS NOT NULL
GROUP BY 1 ORDER BY 1;

SELECT count(*) AS reserved_or_pending_deletes,
       coalesce(sum(byte_count), 0) AS known_reserved_bytes,
       count(*) FILTER (WHERE byte_count IS NULL) AS older_entries_with_unknown_size
FROM chatcode_object_cleanup;
