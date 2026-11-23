// Loaded only in the test server. Exercise SDK signing and serialization in memory,
// and keep mock bucket bytes on disk across server restarts.
import assert from "node:assert/strict";
import { access, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";

function getDirectory() {
  const dir = process.env.CHATCODE_TEST_OBJECT_DIR;
  assert.ok(dir && process.env.NODE_ENV === "test", "CHATCODE_TEST_OBJECT_DIR must be set in test environment");
  return dir;
}

const handler = new S3Client({region:"auto"}).config.requestHandler;
Object.getPrototypeOf(handler).handle = async function(request) {
  const directory = getDirectory();
  const r2 = request.hostname === "a".repeat(32) + ".r2.cloudflarestorage.com";
  assert.ok(r2 || request.hostname === "legacy.invalid");
  if (request.query?.["list-type"] === "2") {
    assert.ok(r2);
    assert.equal(request.query.prefix,"chatcode/r2/");
    const after=request.query["continuation-token"] || "";
    const entries=(await readdir(getDirectory())).filter(name=>name.startsWith("r2-") && name>after).sort();
    const page=entries.slice(0,2);
    const contents=await Promise.all(page.map(async name=>{
      // A concurrent DELETE can remove the directory entry before its size is read.
      try {
        const {size}=await stat(join(directory,name));
        return "<Contents><Key>chatcode/r2/"+name.slice(3)+"</Key><Size>"+size+"</Size></Contents>";
      } catch (error) {
        if (error.code==="ENOENT") return "";
        throw error;
      }
    }));
    const more=entries.length>page.length;
    const xml="<ListBucketResult><IsTruncated>"+more+"</IsTruncated>"+contents.join("")+
      (more?"<NextContinuationToken>"+page.at(-1)+"</NextContinuationToken>":"")+"</ListBucketResult>";
    const failed=!!after && await access(join(getDirectory(),"list-page-offline")).then(()=>true,()=>false);
    const body=Buffer.from(failed?"<Error><Code>AccessDenied</Code></Error>":xml);
    return {response:{statusCode:failed?403:200,headers:{"content-length":String(body.length)},body:Readable.from([body])}};
  }
  const prefix = r2 ? "/test-r2/chatcode/r2/" : "/test-legacy/chatcode/";
  assert.ok(request.path.startsWith(prefix));
  const id = request.path.slice(prefix.length);
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.ok(request.headers.authorization.includes(r2 ? "Credential=r2-test/" : "Credential=legacy-test/"));
  assert.ok(request.headers.authorization.includes(r2 ? "/auto/s3/aws4_request" : "/us-east-1/s3/aws4_request"));
  const path = join(getDirectory(),(r2 ? "r2-" : "legacy-")+id);
  const offline = await access(join(getDirectory(),"offline")).then(()=>true,()=>false);
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
