// Retry: tối đa 3 lượt cho MỖI lời gọi, với exponential backoff.
// Chỉ retry các lỗi tạm thời (503/429/500/quá tải/mạng/response rỗng); lỗi khác ném ngay.
function isRetryable(error: any): boolean {
  const msg: string = error?.message ?? "";
  return (
    error?.retryable === true ||
    error?.status === 503 ||
    error?.status === 429 ||
    error?.status === 500 ||
    msg.includes("503") ||
    msg.includes("500") ||
    msg.includes("Service Unavailable") ||
    msg.includes("high demand") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("overloaded") ||
    // Lỗi mạng / response rỗng / parse fail tạm thời
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("socket hang up") ||
    msg.includes("network")
  );
}

export async function retryGemini<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 2000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (!isRetryable(error) || attempt === maxRetries) {
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
      console.warn(
        `⚠️ Gemini lỗi tạm thời (retryable). Retry ${attempt + 1}/${maxRetries} sau ${Math.round(
          delay
        )}ms... [${error?.message ?? error}]`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Unreachable");
}
