/**
 * Điền "Source URL" trong mục "4Seller set" (cuối form Edit Draft).
 * Đây là metadata NỘI BỘ của 4Seller (dùng nút "Visit" để mở lại nguồn) —
 * KHÔNG đẩy lên TikTok, nên không lo bị detect dropshipping.
 *
 * Không critical: nếu không tìm thấy ô hoặc lỗi → chỉ log cảnh báo, KHÔNG fail listing.
 */
export const fillSourceUrl = async (page: any, sourceUrl?: string): Promise<void> => {
  if (!sourceUrl) {
    console.log("ℹ️ Không có source URL trong data, bỏ qua mục 4Seller set.");
    return;
  }

  try {
    // 1. Click anchor "4Seller set" ở nav phải để nhảy tới section (nếu có).
    const navAnchor = page.locator("text=/^4Seller set$/").first();
    if ((await navAnchor.count()) > 0) {
      await navAnchor.click().catch(() => {});
      await page.waitForTimeout(800);
    }

    // 2. Tìm ô input. Neo chính theo PLACEHOLDER (bền nhất, độc lập class wrapper);
    //    sau đó fallback theo label "Source URL".
    const candidates = [
      page.getByPlaceholder(/source channel of the goods|Record the link to the source/i),
      page.locator(".el-form-item").filter({ hasText: "Source URL" }).locator("input.el-input__inner"),
      page.locator(".el-form-item").filter({ hasText: "Source URL" }).locator("input"),
      page.locator(".el-form-item").filter({ hasText: "Source URL" }).locator("textarea"),
      page.locator(':is(.el-form-item, .el-row, div):has(:text("Visit")):has(:text("Source URL")) :is(input, textarea)'),
    ];

    let input: any = null;
    for (const cand of candidates) {
      if ((await cand.count()) > 0) {
        input = cand.first();
        break;
      }
    }

    if (!input) {
      console.warn("⚠️ Không tìm thấy ô 'Source URL' (4Seller set). Dump HTML để debug:");
      const block = page.locator(':is(.el-form-item, .el-card, section, div):has-text("Source URL")').last();
      const html = await block.evaluate((el: any) => el.outerHTML).catch(() => null);
      console.warn(html ? html.slice(0, 1500) : "(không lấy được HTML)");
      return;
    }

    // 3. Click menu xong vẫn phải trượt thêm 1 đoạn mới thấy ô → force-scroll vào GIỮA
    //    màn hình qua DOM rồi mới điền.
    await input.evaluate((el: HTMLElement) =>
      el.scrollIntoView({ block: "center", inline: "nearest" })
    );
    await page.waitForTimeout(300);

    const matches = (v: string) => !!v && v.includes(sourceUrl.slice(0, 20));

    // Lần 1: fill (nhanh)
    await input.click();
    await input.fill(sourceUrl);
    await page.waitForTimeout(300);
    let val = await input.inputValue().catch(() => "");

    // Lần 2 (fallback): gõ từng ký tự cho component Vue/custom nhận onChange
    if (!matches(val)) {
      console.warn(`⚠️ fill() không vào (got="${val}"), thử pressSequentially...`);
      await input.click();
      await input.fill("").catch(() => {});
      await input.pressSequentially(sourceUrl, { delay: 15 });
      await page.waitForTimeout(300);
      val = await input.inputValue().catch(() => "");
    }

    if (matches(val)) {
      console.log(`🔗 Đã điền Source URL (4Seller set): ${sourceUrl}`);
    } else {
      console.warn(`⚠️ Vẫn không điền được Source URL (got="${val}"). Bỏ qua, không fail listing.`);
    }
  } catch (error: any) {
    console.warn(`⚠️ Lỗi điền Source URL (bỏ qua, không fail listing): ${error?.message ?? error}`);
  }
};
