export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly reservationId?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("INVALID_DATA", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function nonnegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ProviderError("INVALID_DATA", `${label} must be finite and nonnegative`);
  }
  return value;
}

export function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const number = nonnegative(value, label);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new ProviderError("INVALID_DATA", `${label} is outside its integer bounds`);
  }
  return number;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) {
    throw new ProviderError("INVALID_DATA", `${label} must be a nonempty bounded string`);
  }
  return value;
}
