export interface StoredKey {
  id: string;
  provider: string;
  label: string;
  encryptedKey: string;
  iv: string;
  maskedKey: string;
  createdAt: Date;
  lastUsedAt?: Date;
  usageCount: number;
  isValid: boolean;
}

export interface KeyAddRequest {
  provider: string;
  apiKey: string;
  label?: string;
}
