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

      const converted = toTraditionalChinese(code);
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

