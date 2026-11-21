const reported = new WeakSet();
const knownCodes = new Set([
  "AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "NoSuchBucket", "NoSuchKey",
  "InvalidArgument", "InvalidRequest", "RequestTimeTooSkewed", "ExpiredToken", "MissingContentLength",
  "NotImplemented", "SlowDown", "InternalError", "ServiceUnavailable", "RequestTimeout",
  "AbortError", "TimeoutError", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED",
  "ETIMEDOUT", "ERR_INVALID_CHAR", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export async function storageStep(operation, action) {
  try {
    return await action();
  } catch (error) {
    // A failed statement also rejects its transaction. Report only the innermost step.
    if (!error?.publicMessage && !reported.has(error)) {
      if (error instanceof Error) reported.add(error);
      const entry = {event:"storage_failure", operation};
      if (operation.startsWith("postgres.") && typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code))
        entry.sqlstate = error.code;
      else
        entry.code = [error?.code, error?.name].find(code => knownCodes.has(code)) ?? "unknown";
      const status = error?.$metadata?.httpStatusCode;
      if (Number.isInteger(status) && status >= 100 && status <= 599) entry.httpStatus = status;
      console.error(JSON.stringify(entry));
    }
    throw error;
  }
}
