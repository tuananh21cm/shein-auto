import { describe, it, expect } from "vitest";
import { joinCandidatesWithListings } from "./suggestProducts";

const cands = [
  { productId: "P1", productName: "Dress A", pv: 900, avgPerDay: 40, daysTracked: 5, orders: 3, reasons: ["có đơn"] },
  { productId: "P2", productName: "Top B", pv: 600, avgPerDay: 25, daysTracked: 4, orders: 0, reasons: ["đang lên"] },
  { productId: "P404", productName: "Gone", pv: 100, avgPerDay: 20, daysTracked: 3, orders: 0, reasons: ["đang lên"] },
];
const listingIndex = new Map([
  ["P1", { listingId: "L1", title: "Dress A full", mainImage: "http://i/1.jpg|http://i/2.jpg" }],
  ["P2", { listingId: "L2", title: "Top B full", mainImage: "http://i/3.jpg" }],
]);

describe("joinCandidatesWithListings", () => {
  it("match theo productId, lấy listingId + thumb (ảnh đầu của mainImage)", () => {
    const { items, unmatched } = joinCandidatesWithListings(cands as any, listingIndex);
    expect(items.length).toBe(2);
    expect(items[0]).toMatchObject({ productId: "P1", listingId: "L1", thumb: "http://i/1.jpg", reasons: ["có đơn"] });
    expect(items[0].mainImage).toBe("http://i/1.jpg|http://i/2.jpg");
    expect(unmatched).toBe(1); // P404 không còn active trên 4Seller
  });
});
