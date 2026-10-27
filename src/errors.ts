export type ImageToolsErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "DECODE_FAILED"
  | "ENCODE_FAILED"
  | "ABORTED"
  | "TIMEOUT"
  | "BACKEND_UNAVAILABLE"
  | "INVALID_ARGUMENT"
  | "PROVIDER_FAILED";

export class ImageToolsError extends Error {
  readonly code: ImageToolsErrorCode;
  override readonly cause?: unknown;

  constructor(code: ImageToolsErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ImageToolsError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }

  toJSON(): { name: string; code: ImageToolsErrorCode; message: string } {
    return { name: this.name, code: this.code, message: this.message };
  }
}
export class AbortError extends ImageToolsError {
  constructor(message = "The operation was aborted", cause?: unknown) {
    super("ABORTED", message, cause);
    this.name = "AbortError";
  }
}

export class TimeoutError extends ImageToolsError {
  constructor(message = "The operation timed out", cause?: unknown) {
    super("TIMEOUT", message, cause);
    this.name = "TimeoutError";
  }
}

export function isImageToolsError(value: unknown): value is ImageToolsError {
  return value instanceof ImageToolsError;
}

export function isAbortError(value: unknown): boolean {
  if (value instanceof ImageToolsError) {
    return value.code === "ABORTED" || value.code === "TIMEOUT";
  }
  return (
    !!value &&
    typeof value === "object" &&
    (value as { name?: string }).name === "AbortError"
  );
}

export function invalidArgument(message: string): ImageToolsError {
  return new ImageToolsError("INVALID_ARGUMENT", message);
}

export function unsupportedFormat(message: string): ImageToolsError {
  return new ImageToolsError("UNSUPPORTED_FORMAT", message);
}

export function decodeFailed(
  message: string,
  cause?: unknown,
): ImageToolsError {
  return new ImageToolsError("DECODE_FAILED", message, cause);
}

export function encodeFailed(
  message: string,
  cause?: unknown,
): ImageToolsError {
  return new ImageToolsError("ENCODE_FAILED", message, cause);
}

export function backendUnavailable(message: string): ImageToolsError {
  return new ImageToolsError("BACKEND_UNAVAILABLE", message);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AbortError(
      typeof signal.reason === "string" ? signal.reason : undefined,
      signal.reason,
    );
  }
}
