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
