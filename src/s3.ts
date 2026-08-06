import { mkdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { S3Client } from "bun";
import type { S3Options } from "./config.ts";

export type S3Object = {
  key: string;
  size: number;
  lastModified?: Date;
};

type S3Credentials = ConstructorParameters<typeof S3Client>[0];

function endpointFor(options: S3Options): string {
  const endpoint = options.endpoint.replace(/\/+$/, "");
  if (endpoint.includes("://")) {
    return options.useHttps
      ? endpoint.replace(/^http:\/\//i, "https://")
      : endpoint.replace(/^https:\/\//i, "http://");
  }
  return `${options.useHttps ? "https" : "http"}://${endpoint}`;
}

export function s3ObjectKey(dumpsRoot: string, filePath: string): string {
  const rel = relative(resolve(dumpsRoot), resolve(filePath));
  if (!rel || rel.startsWith("..") || rel.includes(`..${"/"}`)) {
    throw new Error("Selected dump must be inside the configured dumps directory");
  }
  return rel.split("\\").join("/");
}

function safeObjectKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw new Error(`Unsafe S3 object key: ${key}`);
  }
  return normalized;
}

export function localPathForS3Object(dumpsRoot: string, key: string): string {
  const safe = safeObjectKey(key);
  const root = resolve(dumpsRoot);
  const path = resolve(root, safe);
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error("S3 object would download outside the dumps directory");
  }
  return path;
}

export function createS3Client(
  options: S3Options,
  secretAccessKey: string,
): S3Client {
  const credentials = {
    bucket: options.bucketName,
    accessKeyId: options.accessKey,
    secretAccessKey,
    endpoint: endpointFor(options),
    region: options.region,
    // Bun uses virtual-hosted addressing by default. S3-compatible services
    // that require path-style addressing can still accept this option.
    virtualHostedStyle: !options.forcePathStyle,
  } as S3Credentials;
  return new S3Client(credentials);
}

export async function listS3Objects(
  options: S3Options,
  secretAccessKey: string,
): Promise<S3Object[]> {
  const credentials = {
    bucket: options.bucketName,
    accessKeyId: options.accessKey,
    secretAccessKey,
    endpoint: endpointFor(options),
    region: options.region,
  } as S3Credentials;
  const result = await S3Client.list(null, credentials);
  return (result.contents ?? [])
    .map((item) => ({
      key: item.key,
      size: item.size ?? 0,
      lastModified: item.lastModified
        ? new Date(item.lastModified)
        : undefined,
    }))
    .filter((item) => item.key.endsWith(".dump") || item.key.endsWith(".dump.enc"))
    .sort((a, b) => b.key.localeCompare(a.key));
}

export async function verifyS3Bucket(
  options: S3Options,
  secretAccessKey: string,
): Promise<void> {
  try {
    await listS3Objects(options, secretAccessKey);
  } catch (err) {
    if (options.createBucketIfNotExists) {
      throw new Error(
        `Cannot access S3 bucket "${options.bucketName}". Bun's native S3 API does not create buckets; create it first or disable createBucketIfNotExists. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    throw err;
  }
}

export async function uploadToS3(
  client: S3Client,
  dumpsRoot: string,
  filePath: string,
): Promise<string> {
  const key = s3ObjectKey(dumpsRoot, filePath);
  await client.file(key).write(Bun.file(filePath));
  return key;
}

export async function downloadFromS3(
  client: S3Client,
  dumpsRoot: string,
  key: string,
): Promise<string> {
  const localPath = localPathForS3Object(dumpsRoot, key);
  await mkdir(dirname(localPath), { recursive: true });
  await Bun.write(localPath, client.file(safeObjectKey(key)));
  return localPath;
}

export function formatS3Object(object: S3Object): string {
  const date = object.lastModified
    ? ` ${object.lastModified.toISOString()}`
    : "";
  return `${basename(object.key)} (${object.size} B)${date}`;
}
