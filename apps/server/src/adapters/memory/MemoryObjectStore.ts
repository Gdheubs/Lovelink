import type {
  ObjectStore,
  PresignUploadInput,
  PresignedUpload,
} from '../../domain/ports/ObjectStore.js';

/**
 * ADAPTER (memory): ObjectStore.
 *
 * Keeps the bytes in a Map and hands back a URL that does not resolve. That is
 * enough for everything the application can test — that the right key was
 * chosen, that permission expires, that a caller checks `isAvailable()` — and
 * nothing here can verify the one thing that actually matters about R2, which
 * is whether the signature validates. Only a real bucket answers that.
 */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { contentType: string; maxBytes: number }>();

  constructor(private readonly available = true) {}

  isAvailable(): boolean {
    return this.available;
  }

  async presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    this.objects.set(input.key, { contentType: input.contentType, maxBytes: input.maxBytes });

    return {
      url: `memory://uploads/${input.key}`,
      key: input.key,
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async urlFor(key: string, _expiresInSeconds: number | null): Promise<string | null> {
    return this.objects.has(key) ? `memory://objects/${key}` : null;
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.objects.clear();
  }
}
