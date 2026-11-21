import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { storageStep } from "./storage-diagnostics.js";

export class MediaConfigurationError extends Error {}

export function mediaStorage(env = process.env) {
  const fields = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ENDPOINT"];
  let r2, r2Bucket;
  if (fields.some(name => env[name] !== undefined && env[name] !== "")) {
    if (!fields.every(name => env[name]?.trim()))
      throw new MediaConfigurationError("Set all five R2 environment variables.");
    const account = env.R2_ACCOUNT_ID.trim();
    const endpoint = env.R2_ENDPOINT.trim();
    r2Bucket = env.R2_BUCKET_NAME.trim();
    const hosts = ["", "eu.", "fedramp."].map(region => account + "." + region + "r2.cloudflarestorage.com");
    if (!/^[a-f0-9]{32}$/i.test(account) || !hosts.some(host =>
      endpoint === "https://" + host || endpoint === "https://" + host + "/"))
      throw new MediaConfigurationError("Check the R2 account ID and HTTPS account endpoint.");
    r2 = new S3Client({
      region: "auto", endpoint, forcePathStyle: true, maxAttempts: 2,
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID.trim(), secretAccessKey: env.R2_SECRET_ACCESS_KEY.trim() },
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  const legacy = env.S3_BUCKET && new S3Client({
    region: env.AWS_REGION || "us-east-1", endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: !!env.S3_ENDPOINT, maxAttempts: 2,
  });
  if (!r2 && !legacy && env.CHATCODE_MEDIA_BACKEND !== "database")
    throw new MediaConfigurationError("Configure R2 or explicitly set CHATCODE_MEDIA_BACKEND=database.");

  function send(key, Command, extra, timeout) {
    const isR2 = key.startsWith("chatcode/r2/");
    const client = isR2 ? r2 : legacy;
    return storageStep((isR2 ? "r2." : "s3.") + Command.name.replace(/Command$/, ""), async () => {
      if (!client) throw new Error("Private object storage unavailable.");
      try {
        return await client.send(new Command({
          Bucket: isR2 ? r2Bucket : env.S3_BUCKET, Key: key, ...extra,
        }), { abortSignal: AbortSignal.timeout(timeout) });
      } catch (err) {
        // A retry of a create-only PUT can find the original, already committed envelope.
        if (extra.IfNoneMatch==="*" && err.name==="PreconditionFailed" && err.$metadata?.httpStatusCode===412) return;
        throw err;
      }
    });
  }
  return {
    newKey: () => r2 ? "chatcode/r2/" + randomUUID() : legacy ? "chatcode/" + randomUUID() : null,
    put: (key, bytes) => send(key, PutObjectCommand, { Body: bytes, ContentType: "application/octet-stream" }, 45000),
    putOnce: (key, bytes) => send(key, PutObjectCommand, { Body: bytes, ContentType: "application/octet-stream", IfNoneMatch:"*" }, 45000),
    async get(key) {
      const result = await send(key, GetObjectCommand, {}, 30000);
      return Buffer.from(await result.Body.transformToByteArray());
    },
    remove: key => send(key, DeleteObjectCommand, {}, 15000),
  };
}
