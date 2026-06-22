import { resolveSpecifics, mapAttributesToFields, matchOption } from "../core/steps/fillSpecifics";
import { specificsMap } from "../config/appConfig";

const attributes = {
  "Details": "Tie Back",
  "Length": "Micro Crop",
  "Neckline": "Halter",
  "Pattern Type": "Zebra Stripe",
  "Occasion": "Beach, Vacation",
  "Festivals": "Valentine's Day",
  "Color": "Black and White",
  "Style": "Casual",
  "Fabric Elasticity": "High Stretch",
  "Material": "Fabric",
  "Composition": "82% Polyester, 18% Elastane",
  "Care Instructions": "Machine wash, do not dry clean",
  "Chest pad": "Removable Padding",
  "Body": "Lined",
  "SKU": "sf2112011558616886",
};

// Giả lập option dropdown 4Seller (theo category áo bơi/clothing)
const fieldOptions: Record<string, string[]> = {
  "Pattern": ["Solid", "Striped", "Floral", "Animal", "Plaid", "Color Block"],
  "Occasion": ["Casual", "Beach", "Party", "Work", "Vacation", "Sports"],
  "Neckline": ["Halter", "V Neck", "Round Neck", "Square Neck", "Off Shoulder"],
  "Clothing Length": ["Crop", "Regular", "Long", "Mini", "Midi"],
  "Sleeve Length": ["Sleeveless", "Short Sleeve", "Long Sleeve"],
  "Style": ["Casual", "Sexy", "Elegant", "Sporty", "Vintage"],
  "Washing Instructions": ["Machine Wash", "Hand Wash", "Dry Clean Only"],
  "Material": ["Polyester", "Cotton", "Spandex", "Nylon", "Fabric"],
  "Feature": ["Padded", "Stretch", "Breathable", "Lined", "Quick Dry"],
  "Design": ["Tie", "Ruched", "Cut Out", "Backless", "Lace Up"],
  "Holiday/Occasion": ["Valentine's Day", "Christmas", "Halloween", "Independence Day"],
};

const cfg = specificsMap();
console.log("--- mapAttributesToFields ---");
console.log(mapAttributesToFields(attributes, cfg.keyMap));
console.log("\n--- resolveSpecifics (kết quả sẽ điền) ---");
const res = resolveSpecifics(attributes, fieldOptions, cfg);
console.log(res);
console.log("\nĐiền được:", Object.keys(res).length, "field");
console.log("\n--- vài case matchOption lẻ ---");
console.log('Zebra Stripe →', matchOption("Zebra Stripe", fieldOptions.Pattern, cfg.valueSynonyms));
console.log('Machine wash... →', matchOption("Machine wash, do not dry clean", fieldOptions["Washing Instructions"], cfg.valueSynonyms));
console.log('Random XYZ →', matchOption("Quantum Flux", fieldOptions.Pattern, cfg.valueSynonyms));
