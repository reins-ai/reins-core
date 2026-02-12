function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class KeyEncryption {
  private readonly masterKey: string;
  private derivedKeyPromise?: Promise<CryptoKey>;
  private readonly salt = new TextEncoder().encode("reins-byok-v1");

  constructor(masterKey: string) {
    this.masterKey = masterKey;
  }

  public async encrypt(plaintext: string): Promise<{ ciphertext: string; iv: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.getOrDeriveKey();
    const payload = new TextEncoder().encode(plaintext);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload);

    return {
      ciphertext: toBase64(new Uint8Array(encrypted)),
      iv: toBase64(iv),
    };
  }

  public async decrypt(ciphertext: string, iv: string): Promise<string> {
    const key = await this.getOrDeriveKey();
    const encryptedBytes = fromBase64(ciphertext);
    const ivBytes = fromBase64(iv);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(ivBytes) },
      key,
      toArrayBuffer(encryptedBytes),
    );

    return new TextDecoder().decode(decrypted);
  }

  private getOrDeriveKey(): Promise<CryptoKey> {
    if (!this.derivedKeyPromise) {
      this.derivedKeyPromise = this.deriveKey();
    }

    return this.derivedKeyPromise;
  }

  private async deriveKey(): Promise<CryptoKey> {
    const secretBytes = new TextEncoder().encode(this.masterKey);
    const material = await crypto.subtle.importKey("raw", secretBytes, "PBKDF2", false, ["deriveKey"]);

    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: toArrayBuffer(this.salt),
        iterations: 100_000,
        hash: "SHA-256",
      },
      material,
      {
        name: "AES-GCM",
        length: 256,
      },
      false,
      ["encrypt", "decrypt"],
    );
  }
}
