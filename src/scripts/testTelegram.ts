/**
 * Test Telegram notify (success + fail mock).
 */
import "dotenv/config";
import { notifySuccess, notifyFail, notifyInfo } from "../services/notification/telegram";
import { config } from "../config";

const main = async () => {
  console.log("▶️ Test Telegram notify...");
  console.log(`   Bot token: ${config.telegramBotToken ? "✓ set" : "✗ MISSING"}`);
  console.log(`   Chat ID  : ${config.telegramChatId ? "✓ set" : "✗ MISSING"}`);

  if (!config.telegramBotToken || !config.telegramChatId) {
    console.error("❌ Token hoặc chat ID chưa set trong .env");
    process.exit(1);
  }

  try {
    console.log("📤 Gửi notify info...");
    await notifyInfo("Test ping từ shein-auto — đây là test nhanh để verify cấu hình.");

    console.log("📤 Gửi notify success...");
    await notifySuccess({
      file: "test_mock.json",
      folder: "P5-014",
      profile: "P5-014_US",
      durationMs: 142_000,
    });

    console.log("📤 Gửi notify fail...");
    await notifyFail({
      file: "test_mock.json",
      folder: "P5-014",
      profile: "P5-014_US",
      errorMessage: "Mock error: Save & Publish trả về toast 'Required field missing'",
    });

    console.log("✅ Done. Kiểm tra Telegram chat xem nhận đủ 3 message không.");
  } catch (err: any) {
    console.error("❌ Lỗi:", err?.message ?? err);
    process.exit(2);
  }
};

main();
