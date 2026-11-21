// Loaded only in the test server. Exercise SDK signing and serialization in memory,
// and keep mock bucket bytes on disk across server restarts.
import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";

const directory = process.env.CHATCODE_TEST_OBJECT_DIR;
assert.ok(directory && process.env.NODE_ENV === "test");
const handler = new S3Client({region:"auto"}).config.requestHandler;
Object.getPrototypeOf(handler).handle = async function(request) {
  const r2 = request.hostname === "a".repeat(32) + ".r2.cloudflarestorage.com";
  assert.ok(r2 || request.hostname === "legacy.invalid");
  const prefix = r2 ? "/test-r2/chatcode/r2/" : "/test-legacy/chatcode/";
  assert.ok(request.path.startsWith(prefix));
  const id = request.path.slice(prefix.length);
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.ok(request.headers.authorization.includes(r2 ? "Credential=r2-test/" : "Credential=legacy-test/"));
  assert.ok(request.headers.authorization.includes(r2 ? "/auto/s3/aws4_request" : "/us-east-1/s3/aws4_request"));
  const path = join(directory,(r2 ? "r2-" : "legacy-")+id);
  const offline = await access(join(directory,"offline")).then(()=>true,()=>false);
  let body = Buffer.alloc(0);
  if(request.method === "PUT") {
    assert.equal(request.headers["content-type"],"application/octet-stream");
    try {
      await writeFile(path,request.body,{flag:request.headers["if-none-match"]==="*"?"wx":"w"});
    } catch (err) {
      if (err.code!=="EEXIST") throw err;
      const error=Buffer.from("<Error><Code>PreconditionFailed</Code></Error>");
      return {response:{statusCode:412,headers:{"content-length":String(error.length)},body:Readable.from([error])}};
    } // Offline PUT also models a lost confirmation after writing bytes.
  } else if(!offline && request.method === "GET") body = await readFile(path);
  else if(!offline && request.method === "DELETE") await rm(path,{force:true});
  else assert.ok(offline);
  if(offline) body=Buffer.from("<Error><Code>AccessDenied</Code></Error>");
  return {response:{statusCode:offline ? 403 : 200,headers:{"content-length":String(body.length)},body:Readable.from([body])}};
};
