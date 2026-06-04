import "dotenv/config";
import { validateProduct } from "../core/research/validateProduct";
const sig = (o: any = {}) => ({ shipDaysMin:null,fastSharePercent:null,seaShipping:false,quickShip:false,mallCode:null,returnType:null,hasSizeChart:true,sizeChartRows:5,material:null,ugcCount:3,trueToSize:null, ...o });
const cases = [
  ["Local hot", { name:"Summer Bikini Set", rating:4.8, fiveStarPct:85, soldNum:6600, discountPct:32, signals:sig({shipDaysMin:6,fastSharePercent:60,trueToSize:88}) }],
  ["Inter (sea)", { name:"Floral Dress", rating:4.6, fiveStarPct:80, soldNum:500, discountPct:30, signals:sig({seaShipping:true,shipDaysMin:35}) }],
  ["Rating thấp", { name:"Cheap Top", rating:3.5, fiveStarPct:40, soldNum:200, discountPct:20, signals:sig({shipDaysMin:6}) }],
  ["Fit kém", { name:"Tight Pants", rating:4.5, fiveStarPct:70, soldNum:300, discountPct:20, signals:sig({shipDaysMin:6,trueToSize:62}) }],
  ["IP risk", { name:"Disney Mickey Pajama Set", rating:4.9, fiveStarPct:90, soldNum:9000, discountPct:30, signals:sig({shipDaysMin:5,trueToSize:90}) }],
] as const;
for (const [label, inp] of cases) {
  const r = validateProduct(inp as any);
  console.log(`${label.padEnd(13)} → ${r.verdict.padEnd(6)} score=${r.validationScore} | ${r.badges.join(" ")}${r.reasons.length?" | "+r.reasons.join("; "):""}`);
}
