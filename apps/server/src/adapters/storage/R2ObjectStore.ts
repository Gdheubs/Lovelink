import { createHash, createHmac } from 'node:crypto';
import type { Logger } from '../../domain/ports/Logger.js';
import type {
  ObjectStore,
  PresignUploadInput,
  PresignedUpload,
} from '../../domain/ports/ObjectStore.js';

/**
 * ADAPTER: Cloudflare R2, over its S3-compatible API.
 *
 * WHY THIS SIGNS REQUESTS BY HAND RATHER THAN USING THE AWS SDK
 * -------------------------------------------------------------
 * The whole adapter needs three things: presign a PUT, presign a GET, and
 * DELETE. AWS SigV4 for a presigned URL is a documented, stable, and entirely
 * deterministic string-building exercise — roughly sixty lines below — and
 * `node:crypto` provides both primitives it uses.
 *
 * `@aws-sdk/client-s3` plus its signing packages is several megabytes and a
 * large transitive tree, pulled in to build a URL. For a project whose premise
 * is a dependency-free core and thin adapters, that is the wrong trade. It
 * would be the right trade the moment this needed multipart uploads, retries
 * with adaptive backoff, or the long tail of S3 semantics — and at that point
 * this file is what gets replaced, which is what the port is for.
 *
 * WHY THE BYTES NEVER COME THROUGH THIS PROCESS
 * ---------------------------------------------
 * See the port. A presigned URL means the client uploads straight to R2, so a
 * 200MB video never occupies a request thread, never sits in this process's
 * memory, and never crosses the API's bandwidth. What stays here is the part
 * that needs judgement: who may upload, under what key, how large, for how long.
 */

export interface R2Config {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  /** Public base URL, when the bucket is served through a domain. */
  readonly publicBaseUrl: string;
}

/** R2 has no regions; SigV4 still requires one, and this is the value it wants. */
const REGION = 'auto';
const SERVICE = 's3';

export class R2ObjectStore implements ObjectStore {
  private readonly host: string;

  constructor(
    private readonly config: R2Config | null,
    private readonly logger: Logger,
  ) {
    this.host = config === null ? '' : `${config.accountId}.r2.cloudflarestorage.com`;
  }

  isAvailable(): boolean {
    return this.config !== null;
  }

  async presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    const url = this.presign('PUT', input.key, input.expiresInSeconds, {
      // Signed, so the client cannot substitute a different type after the
      // fact — an "image/png" that is actually an HTML document is a stored-XSS
      // delivery mechanism when the bucket is served from a domain.
      'content-type': input.contentType,
    });

    return {
      url,
      key: input.key,
      headers: {
        'content-type': input.contentType,
        // R2 enforces this; the API cannot, because it never sees the bytes.
        'content-length-range': `0,${input.maxBytes}`,
      },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async urlFor(key: string, expiresInSeconds: number | null): Promise<string | null> {
    const config = this.require();

    if (expiresInSeconds === null) {
      // A public URL only exists if a domain is actually serving the bucket.
      // Fabricating one that 403s would be worse than admitting there is none.
      if (config.publicBaseUrl.length === 0) return null;
      return `${config.publicBaseUrl.replace(/\/$/, '')}/${encodeKey(key)}`;
    }

    return this.presign('GET', key, expiresInSeconds, {});
  }

  async remove(key: string): Promise<void> {
    const config = this.require();

    const url = this.presign('DELETE', key, 60, {});
    const response = await fetch(url, { method: 'DELETE' });

    // 404 is success for a delete: the object is not there, which is the
    // requested state.
    if (!response.ok && response.status !== 404) {
      this.logger.warn({ status: response.status, bucket: config.bucket }, 'could not delete object');
    }
  }

  private require(): R2Config {
    if (this.config === null) {
      throw new Error('Object storage is not configured. Check isAvailable() first.');
    }
    return this.config;
  }

  /**
   * AWS Signature Version 4, query-string form.
   *
   * The order of operations is fixed by the specification and every step
   * matters — a signature that differs by one byte is simply rejected, with no
   * indication of which step was wrong. That is why this is written out plainly
   * rather than compressed.
   */
  private presign(
    method: string,
    key: string,
    expiresInSeconds: number,
    signedHeaders: Record<string, string>,
  ): string {
    const config = this.require();

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

    // `host` is always signed; anything else the caller named joins it.
    const headers: Record<string, string> = { host: this.host, ...signedHeaders };
    const headerNames = Object.keys(headers).sort();

    const canonicalHeaders = headerNames.map((name) => `${name}:${headers[name]}\n`).join('');
    const signedHeaderList = headerNames.join(';');

    const query = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresInSeconds),
      'X-Amz-SignedHeaders': signedHeaderList,
    });

    // Query parameters must be sorted by name, and URLSearchParams does not
    // sort. An unsorted canonical request produces a valid-looking signature
    // that is always rejected.
    query.sort();

    const canonicalUri = `/${config.bucket}/${encodeKey(key)}`;

    const canonicalRequest = [
      method,
      canonicalUri,
      query.toString(),
      canonicalHeaders,
      signedHeaderList,
      // Unsigned: the body is uploaded directly by the client and is not known
      // here. This is the documented value for a presigned URL.
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    // The signing key is derived by chained HMACs, each keyed on the last.
    const signature = hmac(
      hmac(
        hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), REGION), SERVICE),
        'aws4_request',
      ),
      stringToSign,
    ).toString('hex');

    query.set('X-Amz-Signature', signature);

    return `https://${this.host}${canonicalUri}?${query.toString()}`;
  }
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/**
 * Percent-encode a key for the canonical URI.
 *
 * `encodeURIComponent` escapes `/`, which would break a key containing path
 * segments, and leaves `!'()*` alone, which SigV4 requires escaped. Getting
 * either wrong yields a signature mismatch rather than a helpful error.
 */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}
