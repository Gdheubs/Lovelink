/**
 * PORT: ObjectStore — large files that do not belong in Postgres.
 *
 * WHY THIS EXISTS BEFORE ANYTHING UPLOADS ANYTHING
 * ------------------------------------------------
 * Nothing in the product uploads a file today, and that is deliberate: avatars
 * are generated from a seed precisely so there is no image-abuse surface to
 * moderate. Video is planned, and video is the reason object storage was chosen
 * rather than a column.
 *
 * The port is defined now because the decision it encodes — that the
 * application never streams bytes through itself — is much cheaper to make
 * before there is a feature than after. See `presignUpload`.
 *
 * WHY THE APPLICATION NEVER TOUCHES THE BYTES
 * -------------------------------------------
 * The obvious design has the client POST a file to the API, which forwards it
 * to storage. It is also the one that falls over: a 200MB upload occupies a
 * request thread for minutes, multiplies memory by the number of concurrent
 * uploaders, and puts the API's own bandwidth in the path of something the
 * storage provider will do better and cheaper.
 *
 * So the API issues a PRESIGNED URL and the client uploads directly. The bytes
 * never enter this process. What the API keeps is the part that actually needs
 * judgement: who may upload, what key it lands under, how big it may be, and
 * how long the permission lasts.
 *
 * WHY IT IS S3-COMPATIBLE IN SHAPE
 * --------------------------------
 * Cloudflare R2 is the intended implementation and speaks the S3 API. Keeping
 * the port's vocabulary to key/bucket/presign means R2, S3, B2 or MinIO are all
 * one adapter, and a local dev environment can use none of them.
 */

export interface PresignedUpload {
  /** Where the client PUTs the bytes. Short-lived. */
  readonly url: string;
  /** The key the object will live under, for storing alongside the record. */
  readonly key: string;
  /** Headers the client MUST send for the signature to validate. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface PresignUploadInput {
  /**
   * The object key.
   *
   * Chosen by the CALLER, never by the client. A client-supplied key is a path
   * traversal and an overwrite primitive in one — nothing stops it naming
   * someone else's object.
   */
  readonly key: string;
  readonly contentType: string;
  /**
   * Maximum size the signature will permit, in bytes.
   *
   * Enforced by the storage provider rather than by us, which is the only place
   * it can be enforced given the bytes never come through here.
   */
  readonly maxBytes: number;
  readonly expiresInSeconds: number;
}

export interface ObjectStore {
  /**
   * Permission for one client to upload one object, for a short time.
   */
  presignUpload(input: PresignUploadInput): Promise<PresignedUpload>;

  /**
   * A URL to read an object.
   *
   * `expiresInSeconds` null means "public": valid only where the bucket is
   * served through a public domain, and the adapter says so rather than
   * inventing one.
   */
  urlFor(key: string, expiresInSeconds: number | null): Promise<string | null>;

  /** Remove an object. Silent when it was already gone. */
  remove(key: string): Promise<void>;

  /**
   * Whether storage is configured at all.
   *
   * A deployment with no bucket is a supported state — local development has
   * none — and callers are expected to check rather than to fail.
   */
  isAvailable(): boolean;
}
