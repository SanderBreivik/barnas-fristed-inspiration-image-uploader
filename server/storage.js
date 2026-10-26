// Object storage (Tigris, S3 compatible). Everything goes through the exported
// `storage` object so tests can replace individual functions.
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { env } from "./config.js";

const s3 = new S3Client({
  region: env.S3_REGION || "auto",
  endpoint: env.S3_ENDPOINT,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});
const bucket = env.S3_BUCKET;

async function put(key, body, contentType = "image/webp") {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}
async function get(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await r.Body.transformToByteArray());
}
async function del(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
async function list(prefix, maxKeys) {
  const out = [];
  let token;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
        ...(maxKeys ? { MaxKeys: maxKeys } : {}),
      }),
    );
    for (const o of r.Contents || [])
      out.push({ key: o.Key, size: o.Size, lastModified: o.LastModified });
    token = !maxKeys && r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export const storage = { put, get, del, list };
