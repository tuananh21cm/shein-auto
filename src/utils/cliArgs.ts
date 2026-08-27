/**
 * Đọc tham số CLI dạng --key=value.
 * Windows PowerShell: `npm run x -- --key=value` bị npm.ps1 nuốt mất `--key=value` ở argv,
 * NHƯNG npm vẫn set biến môi trường `npm_config_<key>`. Nên fallback sang env đó.
 *
 * Gọi được cả 2 cách:
 *   npx tsx script.ts --by=duyduc          (argv)
 *   npm run hub:import-local --by=duyduc    (npm_config_by)  ← bỏ luôn dấu `--`
 */
export function cliArg(key: string): string | undefined {
  const flag = process.argv.find((a) => a.startsWith(`--${key}=`));
  if (flag) return flag.slice(key.length + 3);
  const env = process.env[`npm_config_${key}`] ?? process.env[`npm_config_${key.replace(/-/g, "_")}`];
  return env && String(env).trim() ? String(env).trim() : undefined;
}
