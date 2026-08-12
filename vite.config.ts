import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { toTraditionalChinese } from "./scripts/zhTw";

function traditionalChineseRenderer(): Plugin {
  return {
    name: "traditional-chinese-renderer",
    enforce: "pre",
    transform(code, id) {
      const sourceId = id.split("?", 1)[0].replace(/\\/gu, "/");
      if (!sourceId.includes("/src/") || !sourceId.endsWith(".tsx")) {
        return null;
      }

      const converted = toTraditionalChinese(code)
        .replace(/准/gu, "準")
        .replace(/栏/gu, "欄")
        .replace(/后/gu, "後")
        .replace(/页/gu, "頁")
        .replace(/当/gu, "當")
        .replace(/钮/gu, "鈕")
        .replace(/幹淨/gu, "乾淨");
      return converted === code ? null : { code: converted, map: null };
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [traditionalChineseRenderer(), react()],
  server: {
    host: "127.0.0.1",
    port: 5173
  },
  preview: {
    host: "127.0.0.1",
    port: 4173
  }
});

