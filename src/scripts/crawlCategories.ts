/**
 * crawlCategories — duyệt TOÀN BỘ cây category TikTok Shop US từ 4Seller
 * (POST /api/meta/tiktok/get-category-list, leafCategory=1 là leaf) và ghi
 * danh sách leaf path đầy đủ vào config/tiktok-categories.json.
 *
 * Chạy: npx tsx src/scripts/crawlCategories.ts
 */
import fs from "fs-extra";
import path from "path";
import { getShopList, getCategoryList, type CategoryNode } from "../services/fourseller/client";
import { listAccounts } from "../state/fourSellerAccounts";

const OUT_FILE = path.resolve(process.cwd(), "config", "tiktok-categories.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const accounts = await listAccounts();
  if (!accounts.length) throw new Error("Chưa có tài khoản 4Seller nào (tab Cookie).");
  const principal = `acct:${accounts[0].uid}`;
  const shops = await getShopList(principal);
  const shopId = shops.records?.[0]?.id;
  if (!shopId) throw new Error("Tài khoản không có shop nào để lấy shopId.");
  console.log(`🗂️  Crawl category tree qua ${accounts[0].label} (shopId=${shopId})…`);

  const leaves: string[] = [];       // full path " / " joined
  const seenLeaf = new Set<string>();
  let apiCalls = 0;
  let maxDepthReached = 0;

  // DFS đệ quy: pathParts = tên các cấp cha (để ghép path chuẩn " / ").
  async function walk(parentId: string | number, pathParts: string[], depth: number): Promise<void> {
    maxDepthReached = Math.max(maxDepthReached, depth);
    let children: CategoryNode[];
    try {
      apiCalls++;
      children = await getCategoryList(principal, parentId, shopId);
    } catch (e: any) {
      console.warn(`   ⚠️ parentId=${parentId} lỗi: ${e?.message}`);
      return;
    }
    await sleep(120); // nhẹ nhàng với API (tránh rate-limit)

    for (const node of children ?? []) {
      const name = (node.categoryName || "").trim();
      if (!name) continue;
      const parts = [...pathParts, name];
      if (node.leafCategory === 1) {
        const full = parts.join(" / ");
        if (!seenLeaf.has(full)) {
          seenLeaf.add(full);
          leaves.push(full);
          if (leaves.length % 250 === 0) console.log(`   … ${leaves.length} leaf (API calls: ${apiCalls})`);
        }
      } else {
        await walk(node.categoryId, parts, depth + 1);
      }
    }
  }

  const t0 = Date.now();
  await walk(0, [], 0);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  leaves.sort();
  const rootCount: Record<string, number> = {};
  for (const p of leaves) {
    const r = p.split(" / ")[0];
    rootCount[r] = (rootCount[r] || 0) + 1;
  }

  const out = {
    _comment: `TikTok Shop US master leaf categories — cào tự động từ 4Seller ngày ${new Date().toISOString().slice(0, 10)}. Truyền vào Gemini để map category SHEIN gốc. Chạy lại: npx tsx src/scripts/crawlCategories.ts`,
    _meta: {
      crawledAt: new Date().toISOString(),
      totalLeaves: leaves.length,
      maxDepth: maxDepthReached,
      apiCalls,
      byRoot: rootCount,
    },
    categories: leaves,
  };
  await fs.writeJson(OUT_FILE, out, { spaces: 2 });

  console.log(`\n✅ Xong trong ${secs}s · ${apiCalls} API calls · ${leaves.length} leaf category`);
  console.log(`📁 Ghi: ${OUT_FILE}`);
  console.log("Theo root:");
  for (const [k, v] of Object.entries(rootCount).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(v).padStart(5)} × ${k}`);
  }
}

main().catch((e) => {
  console.error("❌", e?.message ?? e);
  process.exit(1);
});
