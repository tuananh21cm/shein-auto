export async function retryGemini<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 2000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isRetryable =
        error?.status === 503 ||
        error?.message?.includes("503") ||
        error?.message?.includes("Service Unavailable") ||
        error?.message?.includes("high demand") ||
        error?.message?.includes("RESOURCE_EXHAUSTED") ||
        error?.status === 429;

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
      console.warn(`⚠️ Gemini API attempt ${attempt + 1}/${maxRetries + 1} failed (retryable). Retrying in ${Math.round(delay)}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Unreachable");
}
