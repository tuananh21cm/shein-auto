export const generateRandomString = (length: number = 10): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

import path from "path";

export const getProfileNameFromFolder = (jsonFile: string): string => {
  const folderName = path.basename(path.dirname(jsonFile));
  if (folderName.includes("_")) return folderName;
  return `${folderName}_US`;
};

/**
 * Chuẩn hoá tên shop để gắn vào SKU: bỏ prefix "tiktok_", bỏ market suffix (_US/_UK...),
 * bỏ dấu tiếng Việt, bỏ space + ký tự đặc biệt → viết liền. Vd "Memetee Shop_US" → "MemeteeShop".
 */
export const normalizeShopName = (profile: string): string =>
  (profile || "")
    .replace(/^tiktok_/i, "")
    .replace(/_(US|UK|DE|FR|IT|ES)$/i, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "");
