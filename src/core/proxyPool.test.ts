import { describe, it, expect } from "vitest";
import { parseProxyLine } from "./proxyPool";

describe("parseProxyLine", () => {
  it("host:port:user:pass → socks5 upstream", () => {
    const p = parseProxyLine("104.161.22.150:28165:proxy:eb6561fd", "socks5");
    expect(p?.upstream).toBe("socks5://proxy:eb6561fd@104.161.22.150:28165");
    expect(p?.label).toBe("socks5://104.161.22.150:28165");
  });
  it("host:port (no auth)", () => {
    expect(parseProxyLine("1.2.3.4:8080", "http")?.upstream).toBe("http://1.2.3.4:8080");
  });
  it("URL sẵn → giữ nguyên, che pass", () => {
    const p = parseProxyLine("socks5://u:secret@h:1080");
    expect(p?.upstream).toBe("socks5://u:secret@h:1080");
    expect(p?.label).toBe("socks5://u:***@h:1080");
  });
  it("bỏ dòng rỗng/comment", () => {
    expect(parseProxyLine("")).toBeNull();
    expect(parseProxyLine("# note")).toBeNull();
  });
  it("encode ký tự đặc biệt trong pass", () => {
    expect(parseProxyLine("h:1:u:p@ss", "socks5")?.upstream).toBe("socks5://u:p%40ss@h:1");
  });
});
