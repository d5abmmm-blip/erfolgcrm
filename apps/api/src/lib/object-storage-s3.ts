/**
 * S3-драйвер ObjectStorage для Yandex Object Storage (S3-compatible).
 *
 * Конфигурация через env:
 *   STORAGE_DRIVER=s3
 *   S3_ENDPOINT=https://storage.yandexcloud.net
 *   S3_REGION=ru-central1
 *   S3_BUCKET=erfolgcrm-prod   ← если не задан BUCKET_TEMPLATE
 *   S3_BUCKET_TEMPLATE=erfolgcrm-prod-{tenant}  ← опционально, per-tenant
 *   S3_ACCESS_KEY=...
 *   S3_SECRET_KEY=...
 *   S3_FORCE_PATH_STYLE=true  ← для совместимости со старыми клиентами
 *   S3_KMS_KEY_ID=...         ← опц., header x-amz-server-side-encryption-aws-kms-key-id
 *
 * Ключи объектов формируются глобально вне этого файла (buildObjectKey),
 * первая компонента — tenants/<id>, поэтому даже на одиночном bucket
 * tenant-изоляция через RLS на attachments + ACL'ы bucket'а.
 */
import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectStorage, ObjectMeta, PresignedGet, PresignedPut } from './object-storage';

interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  defaultBucket: string;
  bucketTemplate: string | null;
  forcePathStyle: boolean;
  kmsKeyId: string | null;
}

function readConfig(): S3Config {
  const endpoint = process.env.S3_ENDPOINT ?? 'https://storage.yandexcloud.net';
  const region = process.env.S3_REGION ?? 'ru-central1';
  const accessKeyId = process.env.S3_ACCESS_KEY ?? '';
  const secretAccessKey = process.env.S3_SECRET_KEY ?? '';
  const defaultBucket = process.env.S3_BUCKET ?? '';
  const bucketTemplate = process.env.S3_BUCKET_TEMPLATE ?? null;
  const forcePathStyle = (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true';
  const kmsKeyId = process.env.S3_KMS_KEY_ID ?? null;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('S3 driver: S3_ACCESS_KEY / S3_SECRET_KEY обязательны при STORAGE_DRIVER=s3');
  }
  if (!defaultBucket && !bucketTemplate) {
    throw new Error('S3 driver: задайте S3_BUCKET или S3_BUCKET_TEMPLATE');
  }
  return { endpoint, region, accessKeyId, secretAccessKey, defaultBucket, bucketTemplate, forcePathStyle, kmsKeyId };
}

let _client: S3Client | null = null;
let _config: S3Config | null = null;

function client(): S3Client {
  if (_client && _config) return _client;
  _config = readConfig();
  _client = new S3Client({
    endpoint: _config.endpoint,
    region: _config.region,
    forcePathStyle: _config.forcePathStyle,
    credentials: {
      accessKeyId: _config.accessKeyId,
      secretAccessKey: _config.secretAccessKey,
    },
  });
  return _client;
}

function bucketForKey(key: string): string {
  const cfg = _config ?? readConfig();
  if (!cfg.bucketTemplate) return cfg.defaultBucket;
  // ключ имеет формат "tenants/<tenantId>/..."; вытаскиваем tenantId.
  const parts = key.split('/');
  const tenantId = parts[0] === 'tenants' && parts[1] ? parts[1] : 'shared';
  return cfg.bucketTemplate.replace('{tenant}', tenantId);
}

const DEFAULT_PUT_TTL = 15 * 60;
const DEFAULT_GET_TTL = 60 * 60;

export const s3ObjectStorage: ObjectStorage = {
  async presignPut({ key, mimeType, sizeBytes, ttlSeconds }) {
    const cfg = _config ?? readConfig();
    const bucket = bucketForKey(key);
    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: mimeType,
      ContentLength: sizeBytes,
      ...(cfg.kmsKeyId
        ? {
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: cfg.kmsKeyId,
          }
        : {}),
    });
    const ttl = ttlSeconds ?? DEFAULT_PUT_TTL;
    const url = await getSignedUrl(client(), cmd, { expiresIn: ttl });
    const headers: Record<string, string> = {
      'Content-Type': mimeType,
      'Content-Length': String(sizeBytes),
    };
    if (cfg.kmsKeyId) {
      headers['x-amz-server-side-encryption'] = 'aws:kms';
      headers['x-amz-server-side-encryption-aws-kms-key-id'] = cfg.kmsKeyId;
    }
    return {
      url,
      headers,
      expiresAt: new Date(Date.now() + ttl * 1000),
    };
  },

  async presignGet(key, ttlSeconds): Promise<PresignedGet> {
    const cmd = new GetObjectCommand({ Bucket: bucketForKey(key), Key: key });
    const ttl = ttlSeconds ?? DEFAULT_GET_TTL;
    const url = await getSignedUrl(client(), cmd, { expiresIn: ttl });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000) };
  },

  async putBuffer(key, data, mimeType): Promise<void> {
    const cfg = _config ?? readConfig();
    await client().send(
      new PutObjectCommand({
        Bucket: bucketForKey(key),
        Key: key,
        Body: data,
        ContentType: mimeType,
        ...(cfg.kmsKeyId
          ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: cfg.kmsKeyId }
          : {}),
      }),
    );
  },

  async head(key): Promise<ObjectMeta | null> {
    try {
      const out = await client().send(
        new HeadObjectCommand({ Bucket: bucketForKey(key), Key: key }),
      );
      return {
        key,
        sizeBytes: out.ContentLength ?? 0,
        mimeType: out.ContentType ?? 'application/octet-stream',
        uploadedAt: out.LastModified ?? new Date(),
      };
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async remove(key): Promise<void> {
    try {
      await client().send(new DeleteObjectCommand({ Bucket: bucketForKey(key), Key: key }));
    } catch (err: unknown) {
      if (isNotFound(err)) return;
      throw err;
    }
  },
};

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true;
  if (e.$metadata?.httpStatusCode === 404) return true;
  return false;
}

/** Только для тестов — сбрасывает кэш клиента, чтобы env-изменения подхватились заново. */
export function __resetS3ClientForTesting(): void {
  _client = null;
  _config = null;
}

// Type guards для presigned put/get (re-export для совместимости тестов).
export type { PresignedPut, PresignedGet, ObjectMeta };
