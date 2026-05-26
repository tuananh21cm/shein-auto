export const cleanTitle = (input: any, brand: string = ""): string => {
  let rawText = "";
  if (typeof input === "object" && input !== null) {
    if (input.text && input.text.thirdPartyData) {
      rawText = brand + " " + input.text.thirdPartyData;
    } else if (input.thirdPartyData) {
      rawText = brand + " " + input.thirdPartyData;
    } else {
      rawText = brand + " " + JSON.stringify(input);
    }
  } else if (typeof input === "string") {
    if (input.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(input);
        rawText = brand + " " + (parsed.thirdPartyData || (parsed.text && parsed.text.thirdPartyData) || input);
      } catch {
        rawText = brand + " " + input;
      }
    } else {
      rawText = brand + " " + input;
    }
  }
  return rawText || "";
};
